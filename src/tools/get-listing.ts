import { ToolError, defineTool, log } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { extractRelayPayloads, fetchPageHtml, findListingDetailById } from '../facebook-api.js';
import {
  type RawMarketplaceListingNode,
  mapMarketplaceListingDetail,
  marketplaceListingDetailSchema,
} from './schemas.js';

export const getListing = defineTool({
  name: 'get_listing',
  displayName: 'Get Marketplace Listing',
  summary: 'Get full details for a Marketplace listing',
  description:
    'Given a Marketplace listing id, returns full details: title, price, description, photos, ' +
    "location, seller, condition, and status. Fetches the listing's SSR page and merges fields from " +
    'every Relay-prefetched fragment that references the listing id.',
  icon: 'shopping-bag',
  group: 'Marketplace',
  input: z.object({
    listing_id: z.string().min(1).describe('Marketplace listing ID (e.g., one returned by list_my_listings)'),
  }),
  output: z.object({
    listing: marketplaceListingDetailSchema,
  }),
  handle: async params => {
    const url = `https://www.facebook.com/marketplace/item/${encodeURIComponent(params.listing_id)}/`;
    log.info('get_listing:fetch', { url });

    const html = await fetchPageHtml(url);
    const merged = findListingDetailById<RawMarketplaceListingNode>(extractRelayPayloads(html), params.listing_id);
    if (!merged) {
      throw ToolError.notFound(
        `Listing ${params.listing_id} not found at ${url}. It may be removed or unavailable to your account.`,
      );
    }
    return { listing: mapMarketplaceListingDetail(merged) };
  },
});
