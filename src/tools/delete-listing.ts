import { ToolError, defineTool, log } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getCurrentUserId, graphql } from '../facebook-api.js';

const DELETE_OP = 'useCometMarketplaceForSaleItemDeleteMutation';

interface DeleteMutationResponse {
  commerce_for_sale_item_delete?: {
    deleted_for_sale_item_id?: string;
    viewer?: { items?: { count_up_to?: number } };
  };
}

export const deleteListing = defineTool({
  name: 'delete_listing',
  displayName: 'Delete Marketplace Listing',
  summary: 'Permanently delete one of your Marketplace listings',
  description:
    'Permanently deletes a Marketplace listing owned by the current user. The listing is removed ' +
    'from the seller dashboard and is no longer visible to buyers. The deletion is irreversible. ' +
    'Returns the deleted listing id and the current count of remaining listings.',
  icon: 'trash',
  group: 'Marketplace',
  input: z.object({
    listing_id: z.string().min(1).describe('Marketplace listing ID to delete (e.g., from my_listings)'),
  }),
  output: z.object({
    deleted_id: z.string().describe('The id of the listing that was deleted'),
    remaining_count: z.number().int().describe("Approximate count of the seller's remaining listings after deletion"),
  }),
  handle: async params => {
    const actorId = getCurrentUserId();
    if (!actorId) throw ToolError.auth('Not authenticated — please log in to Facebook.');

    log.info('delete_listing:submit', { listing_id: params.listing_id });

    const input = {
      actor_id: actorId,
      client_mutation_id: '1',
      batch_delete_variants: true,
      for_sale_item_id: params.listing_id,
      referral_surface: 'COMPOSER',
      surface: 'MARKETPLACE_PAGE_SELLING',
    };

    const resp = await graphql<DeleteMutationResponse>(DELETE_OP, { input });
    const deletedId = resp?.commerce_for_sale_item_delete?.deleted_for_sale_item_id;
    if (!deletedId) {
      throw ToolError.internal('Delete mutation returned no deleted_for_sale_item_id.');
    }
    if (deletedId !== params.listing_id) {
      throw ToolError.internal(`Delete mutation returned id ${deletedId} but ${params.listing_id} was requested.`);
    }

    const remainingCount = resp?.commerce_for_sale_item_delete?.viewer?.items?.count_up_to ?? 0;
    return { deleted_id: deletedId, remaining_count: remainingCount };
  },
});
