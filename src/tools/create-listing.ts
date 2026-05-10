import { ToolError, defineTool, log } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  extractRelayPayloads,
  fetchPageHtml,
  findCurrentMarketplaceId,
  findListingDetailById,
  findPrimaryCurrency,
  findSellLocation,
  getCurrentUserId,
  graphql,
  uploadPhoto,
} from '../facebook-api.js';
import {
  type RawMarketplaceListingNode,
  mapMarketplaceListingDetail,
  marketplaceListingDetailSchema,
} from './schemas.js';

const CREATE_OP = 'useCometMarketplaceListingCreateMutation';
const COMPOSER_URL = 'https://www.facebook.com/marketplace/create/item';

// Same condition mapping as edit_listing: input is upper-cased canonical;
// FB's mutation expects lowercase.
const CONDITION_INPUT_TO_FB = {
  NEW: 'new',
  USED_LIKE_NEW: 'used_like_new',
  USED_GOOD: 'used_good',
  USED_FAIR: 'used_fair',
} as const;

interface CreateMutationResponse {
  marketplace_listing_create?: { listing?: RawMarketplaceListingNode };
}

export const createListing = defineTool({
  name: 'create_listing',
  displayName: 'Create Marketplace Listing',
  summary: 'Publish a new Marketplace listing (single item for sale)',
  description:
    'Creates and publishes a new "Item for sale" listing on Facebook Marketplace. Photos are uploaded ' +
    "to FB and then attached. Location, currency, and marketplace_id are read from the seller's composer " +
    "state. category_id must be supplied (look up an existing listing's category_id via list_my_listings " +
    "if unsure). Returns the new listing detail. The listing may enter a 'review' state before going live.",
  icon: 'plus-circle',
  group: 'Marketplace',
  input: z.object({
    title: z.string().min(1).max(200).describe('Listing title'),
    price: z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .describe('Price as a numeric string in the seller\'s currency (e.g., "5" or "12.50")'),
    description: z.string().min(1).describe('Listing description text'),
    category_id: z
      .string()
      .min(1)
      .describe(
        'Facebook Marketplace category ID (e.g., "1569171756675761" for Home / Garden / Decor). Reuse a category_id from an existing similar listing via list_my_listings.',
      ),
    condition: z.enum(['NEW', 'USED_LIKE_NEW', 'USED_GOOD', 'USED_FAIR']).describe('Item condition'),
    photos: z
      .array(
        z.object({
          data: z.string().min(1).describe('Base64-encoded image bytes (no "data:" prefix)'),
          mime: z
            .string()
            .regex(/^image\/(jpeg|png|webp|heic|gif)$/)
            .default('image/jpeg')
            .describe('MIME type of the image'),
          filename: z.string().default('photo.jpg').describe('Filename to send in the upload'),
        }),
      )
      .min(1)
      .max(20)
      .describe('At least one photo (max 20). Uploaded in order; the first photo becomes the cover.'),
    delivery_types: z
      .array(z.enum(['IN_PERSON', 'SHIPPING']))
      .default(['IN_PERSON'])
      .describe('Delivery methods offered. Defaults to in-person only.'),
  }),
  output: z.object({ listing: marketplaceListingDetailSchema }),
  handle: async params => {
    log.info('create_listing:start', { title: params.title, photo_count: params.photos.length });

    // 1. Fetch composer SSR to pull lat/lng + currency + marketplace_id.
    const html = await fetchPageHtml(COMPOSER_URL);
    const payloads = extractRelayPayloads(html);

    const sellLocation = findSellLocation(payloads);
    if (!sellLocation) {
      throw ToolError.internal("Couldn't find sell_location in composer SSR — can't build the create mutation.");
    }
    const currency = findPrimaryCurrency(payloads) ?? 'USD';
    const marketplaceId = findCurrentMarketplaceId(payloads);
    if (!marketplaceId) {
      throw ToolError.internal("Couldn't find current_marketplace.id in composer SSR.");
    }
    const actorId = getCurrentUserId();
    if (!actorId) throw ToolError.auth('Not authenticated.');

    // 2. Upload each photo sequentially. Order = listing photo order.
    const photoIds: string[] = [];
    for (const [i, photo] of params.photos.entries()) {
      log.debug('create_listing:upload', { index: i, mime: photo.mime, filename: photo.filename });
      const id = await uploadPhoto(photo.data, photo.mime, photo.filename, marketplaceId);
      photoIds.push(id);
    }
    log.debug('create_listing:photos_uploaded', { photoIds });

    // 3. Build mutation input. Field set + defaults mirror what the FB UI sends.
    const shippingOffered = params.delivery_types.includes('SHIPPING');
    const input = {
      actor_id: actorId,
      client_mutation_id: '1',
      audience: { marketplace: { marketplace_id: marketplaceId } },
      data: {
        common: {
          attribute_data_json: JSON.stringify({ condition: CONDITION_INPUT_TO_FB[params.condition] }),
          category_id: params.category_id,
          comments_disabled: false,
          commerce_shipping_carrier: null,
          commerce_shipping_carriers: [],
          comparable_price: 'null',
          cost_per_additional_item: null,
          delivery_types: params.delivery_types,
          description: { text: params.description },
          draft_type: null,
          hidden_from_friends_visibility: 'VISIBLE_TO_EVERYONE',
          is_personalization_required: null,
          is_photo_order_set_by_seller: false,
          is_preview: false,
          item_price: { currency, price: params.price },
          latitude: sellLocation.latitude,
          listing_email_id: null,
          longitude: sellLocation.longitude,
          min_acceptable_checkout_offer_price: 'null',
          personalization_info: null,
          photo_ids: photoIds,
          product_hashtag_names: [],
          quantity: null,
          shipping_calculation_logic_version: null,
          shipping_cost_option: 'BUYER_PAID_SHIPPING',
          shipping_cost_range_lower_cost: null,
          shipping_cost_range_upper_cost: null,
          shipping_label_price: '0',
          shipping_label_rate_code: null,
          shipping_label_rate_type: null,
          shipping_offered: shippingOffered,
          shipping_options_data: [],
          shipping_package_weight: null,
          shipping_price: 'null',
          shipping_service_type: null,
          sku: '',
          source_type: 'composer_listing_type_selector',
          suggested_hashtag_names: [],
          surface: 'composer',
          title: params.title,
          variants: [],
          video_ids: [],
          xpost_target_ids: [],
        },
      },
    };

    // 4. Submit create mutation.
    const resp = await graphql<CreateMutationResponse>(CREATE_OP, { input });
    const created = resp?.marketplace_listing_create?.listing;
    if (!created?.id) throw ToolError.internal('Create mutation returned no listing.');
    log.info('create_listing:created', { listing_id: created.id });

    // 5. Re-fetch full PDP for a rich response (mutation gives slim shape).
    const detailUrl = `https://www.facebook.com/marketplace/item/${encodeURIComponent(created.id)}/`;
    const detailHtml = await fetchPageHtml(detailUrl);
    const detailMerged = findListingDetailById<RawMarketplaceListingNode>(extractRelayPayloads(detailHtml), created.id);
    return { listing: mapMarketplaceListingDetail(detailMerged ?? created) };
  },
});
