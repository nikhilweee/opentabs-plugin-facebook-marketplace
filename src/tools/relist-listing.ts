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
  uploadPhotoFromUrl,
} from '../facebook-api.js';
import {
  type RawMarketplaceListingNode,
  mapMarketplaceListingDetail,
  marketplaceListingDetailSchema,
} from './schemas.js';

const CREATE_OP = 'useCometMarketplaceListingCreateMutation';
const DELETE_OP = 'useCometMarketplaceForSaleItemDeleteMutation';
const COMPOSER_URL = 'https://www.facebook.com/marketplace/create/item';

const CONDITION_INPUT_TO_FB = {
  NEW: 'new',
  USED_LIKE_NEW: 'used_like_new',
  USED_GOOD: 'used_good',
  USED_FAIR: 'used_fair',
} as const;

type ConditionInput = keyof typeof CONDITION_INPUT_TO_FB;

interface CreateMutationResponse {
  marketplace_listing_create?: { listing?: RawMarketplaceListingNode };
}

interface DeleteMutationResponse {
  commerce_for_sale_item_delete?: { deleted_for_sale_item_id?: string };
}

export const relistListing = defineTool({
  name: 'relist_listing',
  displayName: 'Relist Marketplace Listing',
  summary: 'Delete a listing and create a fresh copy of it',
  description:
    'Relists a Marketplace listing: deletes the original and creates a new one with the same title, ' +
    'price, description, category, condition, and photos. Useful for getting algorithmic re-promotion ' +
    'beyond what FB\'s built-in "Renew" provides. Optional overrides let you tweak fields during the relist. ' +
    "Photos are re-fetched from the original's CDN URLs and re-uploaded. Returns the new listing detail and " +
    'the deleted (old) id.',
  icon: 'refresh-cw',
  group: 'Marketplace',
  input: z.object({
    listing_id: z.string().min(1).describe('Marketplace listing ID to relist (from my_listings)'),
    title: z.string().min(1).max(200).optional().describe('Override the title on the new listing'),
    price: z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .optional()
      .describe("Override the price (numeric string, listing's currency)"),
    description: z.string().optional().describe('Override the description'),
    condition: z.enum(['NEW', 'USED_LIKE_NEW', 'USED_GOOD', 'USED_FAIR']).optional().describe('Override the condition'),
  }),
  output: z.object({
    old_listing_id: z.string().describe('The id of the deleted (original) listing'),
    listing: marketplaceListingDetailSchema,
  }),
  handle: async params => {
    log.info('relist_listing:start', { listing_id: params.listing_id });

    const actorId = getCurrentUserId();
    if (!actorId) throw ToolError.auth('Not authenticated — please log in to Facebook.');

    // 1. Fetch the existing listing's detail. We need its title/price/desc/category/condition/photos.
    const detailUrl = `https://www.facebook.com/marketplace/item/${encodeURIComponent(params.listing_id)}/`;
    const detailHtml = await fetchPageHtml(detailUrl);
    const original = findListingDetailById<RawMarketplaceListingNode>(
      extractRelayPayloads(detailHtml),
      params.listing_id,
    );
    if (!original) {
      throw ToolError.notFound(`Listing ${params.listing_id} not found — can't relist what doesn't exist.`);
    }
    const mappedOriginal = mapMarketplaceListingDetail(original);
    if (!mappedOriginal.title || !mappedOriginal.category_id || mappedOriginal.photo_urls.length === 0) {
      throw ToolError.internal(
        `Listing ${params.listing_id} is missing required fields (title/category_id/photos) — can't safely relist.`,
      );
    }

    // Snapshot the original — captured BEFORE any destructive action so it's
    // recoverable from `opentabs logs --plugin facebook-marketplace` if the
    // create step (or anything downstream) fails. Photo URLs are FB CDN signed
    // links; they may stay reachable for a short window even after the listing
    // is deleted, useful for quick recovery.
    log.info('relist_listing:original_snapshot', {
      listing_id: params.listing_id,
      title: mappedOriginal.title,
      price: mappedOriginal.price,
      price_amount: mappedOriginal.price_amount,
      description: mappedOriginal.description,
      category_id: mappedOriginal.category_id,
      condition: mappedOriginal.condition,
      photo_urls: mappedOriginal.photo_urls,
    });

    // 2. Fetch composer SSR for sell_location + currency + marketplace_id.
    const composerHtml = await fetchPageHtml(COMPOSER_URL);
    const composerPayloads = extractRelayPayloads(composerHtml);
    const sellLocation = findSellLocation(composerPayloads);
    if (!sellLocation) {
      throw ToolError.internal("Couldn't find sell_location in composer SSR — can't build the create mutation.");
    }
    const currency = findPrimaryCurrency(composerPayloads) ?? 'USD';
    const marketplaceId = findCurrentMarketplaceId(composerPayloads);
    if (!marketplaceId) {
      throw ToolError.internal("Couldn't find current_marketplace.id in composer SSR.");
    }

    // 3. Re-upload each photo from the original's CDN URLs. If any fails, abort
    // before deleting the original.
    const photoIds: string[] = [];
    for (const [i, url] of mappedOriginal.photo_urls.entries()) {
      log.debug('relist_listing:reupload_photo', { index: i });
      const id = await uploadPhotoFromUrl(url, `photo_${i + 1}.jpg`, marketplaceId);
      photoIds.push(id);
    }

    // 4. Delete the original BEFORE creating the new one, so FB's duplicate
    // detection doesn't see two identical listings simultaneously. Brief sleep
    // afterwards to let FB's index catch up.
    const deleteInput = {
      actor_id: actorId,
      client_mutation_id: '1',
      batch_delete_variants: true,
      for_sale_item_id: params.listing_id,
      referral_surface: 'COMPOSER',
      surface: 'MARKETPLACE_PAGE_SELLING',
    };
    const deleteResp = await graphql<DeleteMutationResponse>(DELETE_OP, { input: deleteInput });
    const deletedId = deleteResp?.commerce_for_sale_item_delete?.deleted_for_sale_item_id;
    if (deletedId !== params.listing_id) {
      log.warn('relist_listing:delete_mismatch', { expected: params.listing_id, got: deletedId });
    }
    log.info('relist_listing:deleted_original', { old_id: params.listing_id });
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 5. Build create-mutation input. Field set mirrors create_listing's. Use
    // overrides where supplied, else fall back to the original's values.
    // Condition: original is already PC_-stripped by the mapper (e.g., "USED_LIKE_NEW").
    const finalTitle = params.title ?? mappedOriginal.title;
    const finalPrice = params.price ?? mappedOriginal.price_amount;
    const finalDescription = params.description ?? mappedOriginal.description;
    const finalConditionInput: ConditionInput =
      params.condition ?? ((mappedOriginal.condition || 'USED_GOOD') as ConditionInput);
    if (!(finalConditionInput in CONDITION_INPUT_TO_FB)) {
      throw ToolError.internal(
        `Unexpected condition value "${finalConditionInput}" on original listing — can't map to mutation enum.`,
      );
    }

    const createInput = {
      actor_id: actorId,
      client_mutation_id: '2',
      audience: { marketplace: { marketplace_id: marketplaceId } },
      data: {
        common: {
          attribute_data_json: JSON.stringify({ condition: CONDITION_INPUT_TO_FB[finalConditionInput] }),
          category_id: mappedOriginal.category_id,
          comments_disabled: false,
          commerce_shipping_carrier: null,
          commerce_shipping_carriers: [],
          comparable_price: 'null',
          cost_per_additional_item: null,
          delivery_types: ['IN_PERSON'],
          description: { text: finalDescription },
          draft_type: null,
          hidden_from_friends_visibility: 'VISIBLE_TO_EVERYONE',
          is_personalization_required: null,
          is_photo_order_set_by_seller: false,
          is_preview: false,
          item_price: { currency, price: finalPrice },
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
          shipping_offered: false,
          shipping_options_data: [],
          shipping_package_weight: null,
          shipping_price: 'null',
          shipping_service_type: null,
          sku: '',
          source_type: 'composer_listing_type_selector',
          suggested_hashtag_names: [],
          surface: 'composer',
          title: finalTitle,
          variants: [],
          video_ids: [],
          xpost_target_ids: [],
        },
      },
    };

    // 6. Fire create. If this fails, the original is already gone — the caller
    // needs to recover manually (photos are still uploaded, photo_ids could be
    // reused). Worth surfacing the photo_ids in the error message for recovery.
    const createResp = await graphql<CreateMutationResponse>(CREATE_OP, { input: createInput });
    const newListing = createResp?.marketplace_listing_create?.listing;
    if (!newListing?.id) {
      throw ToolError.internal(
        `Create mutation returned no listing after delete. The old listing (${params.listing_id}) is already deleted. Uploaded photo_ids: ${JSON.stringify(photoIds)} — these can be reused in a manual create_listing retry.`,
      );
    }
    log.info('relist_listing:created', { new_id: newListing.id });

    // 7. Re-fetch the new listing's PDP for a rich response.
    const newDetailUrl = `https://www.facebook.com/marketplace/item/${encodeURIComponent(newListing.id)}/`;
    const newDetailHtml = await fetchPageHtml(newDetailUrl);
    const newDetailMerged = findListingDetailById<RawMarketplaceListingNode>(
      extractRelayPayloads(newDetailHtml),
      newListing.id,
    );
    return {
      old_listing_id: params.listing_id,
      listing: mapMarketplaceListingDetail(newDetailMerged ?? newListing),
    };
  },
});
