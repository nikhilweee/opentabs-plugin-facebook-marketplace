import { ToolError, defineTool, log } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { extractRelayPayloads, fetchPageHtml } from '../facebook-api.js';
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
    const payloads = extractRelayPayloads(html);
    const fragments: RawMarketplaceListingNode[] = [];
    for (const p of payloads) collectMatchingNodes(p.data, params.listing_id, fragments);

    log.debug('get_listing:fragments', { count: fragments.length });
    if (fragments.length === 0) {
      throw ToolError.notFound(
        `Listing ${params.listing_id} not found at ${url}. It may be removed or unavailable to your account.`,
      );
    }

    return { listing: mapMarketplaceListingDetail(mergeFragments(fragments)) };
  },
});

// Recursively collect every node with id === targetId. Each Relay fragment
// only carries a subset of fields, so we accept any node whose __typename
// looks like a marketplace listing — even if it lacks title (which excludes
// fragments that only carry photos, condition, etc.).
const LISTING_TYPENAMES = /^GroupCommerceProductItem$|^Marketplace.*Listing|MarketplaceProductItem/;

const collectMatchingNodes = (data: unknown, targetId: string, out: RawMarketplaceListingNode[]): void => {
  if (!data || typeof data !== 'object') return;
  if (Array.isArray(data)) {
    for (const item of data) collectMatchingNodes(item, targetId, out);
    return;
  }
  const obj = data as Record<string, unknown>;
  if (obj.id === targetId && typeof obj.__typename === 'string' && LISTING_TYPENAMES.test(obj.__typename)) {
    out.push(obj as RawMarketplaceListingNode);
  }
  for (const k of Object.keys(obj)) collectMatchingNodes(obj[k], targetId, out);
};

// Each Relay fragment about the same listing carries a different slice of
// fields. Merge by taking the first meaningful value per key.
const mergeFragments = (fragments: RawMarketplaceListingNode[]): RawMarketplaceListingNode => {
  const merged: Record<string, unknown> = {};
  for (const f of fragments) {
    for (const [key, value] of Object.entries(f)) {
      if (!isMeaningful(merged[key]) && isMeaningful(value)) merged[key] = value;
    }
  }
  return merged as RawMarketplaceListingNode;
};

const isMeaningful = (v: unknown): boolean => {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
};
