import { ToolError, defineTool, log } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { extractSSRQueryMetadata, fetchPageHtml, graphql, populateDocIdCacheFromMetadata } from '../facebook-api.js';
import { type RawMarketplaceListingNode, mapMarketplaceListing, marketplaceListingSchema } from './schemas.js';

const PAGE_URL = 'https://www.facebook.com/marketplace/you/selling';
const SELLING_OP = 'CometMarketplaceYouSellingFastContentContainerQuery';
const PAGINATION_OP = 'MarketplaceYouSellingFastActiveSectionPaginationQuery';
const PAGE_SIZE = 50;
const MAX_PAGES = 20;

export const myListings = defineTool({
  name: 'my_listings',
  displayName: 'My Marketplace Listings',
  summary: 'List your active Marketplace listings',
  description:
    "Returns the current user's active Marketplace listings. Loads the first page via the seller " +
    'page query and paginates with cursor until all listings are fetched. Each listing includes id, ' +
    'title, formatted price, image, sold status, and category id.',
  icon: 'package',
  group: 'Marketplace',
  input: z.object({}),
  output: z.object({
    listings: z.array(marketplaceListingSchema),
    page_url: z.string().describe('URL of the "Your selling" page'),
  }),
  handle: async () => {
    log.info('my_listings:fetch', { url: PAGE_URL });
    const html = await fetchPageHtml(PAGE_URL);
    const metadata = extractSSRQueryMetadata(html);
    populateDocIdCacheFromMetadata(metadata);
    const sellingMeta = metadata.find(m => m.queryName === SELLING_OP);
    if (!sellingMeta) {
      throw ToolError.internal(
        'Could not find seller query metadata in the SSR HTML. Make sure you are logged in to Facebook.',
      );
    }

    const baseVars = { ...sellingMeta.variables, count: PAGE_SIZE };

    const seen = new Set<string>();
    const listings: ReturnType<typeof mapMarketplaceListing>[] = [];

    const ingest = (raw: unknown): { cursor: string | null; added: number } => {
      const edges = findListingEdges(raw);
      let cursor: string | null = null;
      let added = 0;
      for (const edge of edges) {
        const mapped = mapMarketplaceListing({ node: { listing: edge.node } });
        if (mapped.id && !seen.has(mapped.id)) {
          seen.add(mapped.id);
          listings.push(mapped);
          added++;
        }
        if (edge.cursor) cursor = edge.cursor;
      }
      return { cursor, added };
    };

    const firstResp = await graphql(SELLING_OP, baseVars);
    let { cursor } = ingest(firstResp);

    for (let page = 1; cursor && page <= MAX_PAGES; page++) {
      const resp = await graphql(PAGINATION_OP, { ...baseVars, cursor, status: null });
      const result = ingest(resp);
      log.debug('my_listings:page', { page, added: result.added, total: listings.length });
      if (!result.added || !result.cursor || result.cursor === cursor) break;
      cursor = result.cursor;
    }

    if (listings.length === 0) {
      throw ToolError.internal('No active listings found on Marketplace.');
    }

    return { listings, page_url: PAGE_URL };
  },
});

interface EdgeWithCursor {
  node: RawMarketplaceListingNode;
  cursor: string | null;
}

// Walk the response for `node.first_listing` (or `node.listing`) entries —
// the seller-facing connection wraps each listing in a `MarketplaceIndexedListingSet`
// with `first_listing`. Capture the sibling `cursor` for pagination.
const findListingEdges = (data: unknown): EdgeWithCursor[] => {
  const out: EdgeWithCursor[] = [];
  const visit = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    const obj = v as Record<string, unknown>;
    const node = obj.node;
    if (node && typeof node === 'object') {
      const n = node as Record<string, unknown>;
      const listing = (n.first_listing ?? n.listing) as RawMarketplaceListingNode | undefined;
      if (listing && (listing.id || listing.marketplace_listing_title)) {
        out.push({ node: listing, cursor: typeof obj.cursor === 'string' ? obj.cursor : null });
      }
    }
    for (const k of Object.keys(obj)) visit(obj[k]);
  };
  visit(data);
  return out;
};
