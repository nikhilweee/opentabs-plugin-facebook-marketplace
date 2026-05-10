import { ToolError, defineTool, log } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  extractRelayPayloads,
  fetchPageHtml,
  findListingDetailById,
  findPrimaryCurrency,
  findSellLocation,
  getCurrentUserId,
  graphql,
} from '../facebook-api.js';
import {
  type RawMarketplaceListingNode,
  mapMarketplaceListingDetail,
  marketplaceListingDetailSchema,
} from './schemas.js';

const EDIT_OP = 'useCometMarketplaceListingEditMutation';

// Condition values FB accepts in the edit mutation. Read responses use the
// PC_-prefixed enum (e.g. PC_USED_LIKE_NEW); the mutation expects the lowercase
// form. We accept the upper-cased canonical name as input and translate.
const CONDITION_INPUT_TO_FB = {
  NEW: 'new',
  USED_LIKE_NEW: 'used_like_new',
  USED_GOOD: 'used_good',
  USED_FAIR: 'used_fair',
} as const;

interface EditMutationResponse {
  marketplace_listing_edit?: { listing?: RawMarketplaceListingNode };
}

export const editListing = defineTool({
  name: 'edit_listing',
  displayName: 'Edit Marketplace Listing',
  summary: 'Update text fields on one of your Marketplace listings',
  description:
    "Edits text fields (title, price, description, condition) on one of the current user's Marketplace listings. " +
    'At least one of title/price/description/condition must be supplied. Returns the updated listing detail. ' +
    'Photos, category, location, and shipping are preserved unchanged from the listing.',
  icon: 'pencil',
  group: 'Marketplace',
  input: z
    .object({
      listing_id: z.string().min(1).describe('Marketplace listing ID (e.g., from my_listings)'),
      title: z.string().min(1).max(200).optional().describe('New listing title'),
      price: z
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .optional()
        .describe('New price as a numeric string in the listing\'s currency (e.g., "12.50")'),
      description: z.string().optional().describe('New description text'),
      condition: z.enum(['NEW', 'USED_LIKE_NEW', 'USED_GOOD', 'USED_FAIR']).optional().describe('New condition'),
    })
    .refine(
      o => Boolean(o.title || o.price || o.description || o.condition),
      'At least one of title/price/description/condition must be set',
    ),
  output: z.object({ listing: marketplaceListingDetailSchema }),
  handle: async params => {
    const url = `https://www.facebook.com/marketplace/edit/?listing_id=${encodeURIComponent(params.listing_id)}`;
    log.info('edit_listing:fetch_state', { url });

    const html = await fetchPageHtml(url);
    const payloads = extractRelayPayloads(html);

    const listing = findListingDetailById<RawMarketplaceListingNode>(payloads, params.listing_id);
    if (!listing) {
      throw ToolError.notFound(
        `Listing ${params.listing_id} not editable from /marketplace/edit/. It may not exist or you're not the seller.`,
      );
    }
    const sellLocation = findSellLocation(payloads);
    if (!sellLocation) {
      throw ToolError.internal("Couldn't find sell_location in composer SSR — can't safely build the mutation.");
    }
    const currency = findPrimaryCurrency(payloads) ?? 'USD';
    const actorId = getCurrentUserId();
    if (!actorId) throw ToolError.auth('Not authenticated — please log in to Facebook.');

    const photoIds = (listing.listing_photos ?? []).map(p => p?.id).filter((x): x is string => Boolean(x));
    if (photoIds.length === 0) {
      throw ToolError.internal('Listing has no photo IDs in composer state — refusing to edit.');
    }

    const existingAttributes = (listing.attribute_data ?? []).reduce<Record<string, string>>((acc, a) => {
      if (a.attribute_type && a.value) acc[a.attribute_type.toLowerCase()] = a.value;
      return acc;
    }, {});
    if (params.condition) existingAttributes.condition = CONDITION_INPUT_TO_FB[params.condition];

    const existingPriceAmount = parseAmount(listing.item_price?.formatted ?? '');

    const input = {
      actor_id: actorId,
      client_mutation_id: '1',
      data: {
        common: {
          attribute_data_json: JSON.stringify(existingAttributes),
          category_id: listing.marketplace_listing_category_id ?? '',
          comments_disabled: !(listing.mp_comments_enabled ?? true),
          commerce_shipping_carrier: null,
          commerce_shipping_carriers: [],
          comparable_price: 'null',
          comparable_price_type: null,
          cost_per_additional_item: null,
          delivery_types: listing.delivery_types ?? ['IN_PERSON'],
          description: { text: params.description ?? listing.redacted_description?.text ?? '' },
          draft_type: null,
          hidden_from_friends_visibility: listing.hidden_from_friends ?? 'VISIBLE_TO_EVERYONE',
          is_personalization_required: null,
          is_photo_order_set_by_seller: listing.is_photo_order_set_by_seller ?? false,
          is_preview: false,
          item_price: { currency, price: params.price ?? existingPriceAmount },
          latitude: sellLocation.latitude,
          listing_email_id: null,
          longitude: sellLocation.longitude,
          min_acceptable_checkout_offer_price: 'null',
          personalization_info: null,
          product_hashtag_names: [],
          quantity: null,
          shipping_calculation_logic_version: null,
          shipping_cost_option: 'BUYER_PAID_SHIPPING',
          shipping_cost_range_lower_cost: null,
          shipping_cost_range_upper_cost: null,
          shipping_label_price: '0',
          shipping_label_rate_type: null,
          shipping_offered: false,
          shipping_options_data: [],
          shipping_package_weight: null,
          shipping_price: 'null',
          shipping_service_type: null,
          sku: listing.sku ?? '',
          source_type: 'marketplace_page_selling',
          suggested_hashtag_names: [],
          surface: 'edit_composer',
          title: params.title ?? listing.marketplace_listing_title ?? '',
          variants: [],
          video_ids: [],
          photo_ids: photoIds,
        },
      },
      listing_id: params.listing_id,
    };

    log.debug('edit_listing:submit', {
      changed: {
        title: Boolean(params.title),
        price: Boolean(params.price),
        description: Boolean(params.description),
        condition: Boolean(params.condition),
      },
    });

    const resp = await graphql<EditMutationResponse>(EDIT_OP, { input });
    const updated = resp?.marketplace_listing_edit?.listing;
    if (!updated?.id) throw ToolError.internal('Edit mutation returned no listing.');

    // The mutation response carries a slim subset of fields (no description /
    // condition / photos). Re-fetch the listing's PDP SSR + merge fragments
    // for consistency with get_listing's output shape.
    const detailUrl = `https://www.facebook.com/marketplace/item/${encodeURIComponent(params.listing_id)}/`;
    const detailHtml = await fetchPageHtml(detailUrl);
    const detailMerged = findListingDetailById<RawMarketplaceListingNode>(
      extractRelayPayloads(detailHtml),
      params.listing_id,
    );
    return { listing: mapMarketplaceListingDetail(detailMerged ?? updated) };
  },
});

const parseAmount = (formatted: string): string => {
  const m = formatted.match(/[\d,]+(?:\.\d+)?/);
  return m ? m[0].replace(/,/g, '') : '';
};
