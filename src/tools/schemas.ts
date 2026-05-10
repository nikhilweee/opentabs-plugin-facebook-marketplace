import { z } from 'zod';

// ---------------------------------------------------------------------------
// Marketplace listing — summary
// Mirrors plugins/facebook/src/tools/schemas.ts so this can fold into the
// upstream plugin without conflict at PR time.
// ---------------------------------------------------------------------------

export const marketplaceListingSchema = z.object({
  id: z.string().describe('Marketplace listing ID'),
  title: z.string().describe('Listing title'),
  price: z.string().describe('Formatted price (e.g., "$80")'),
  price_amount: z.string().describe('Numeric price amount (e.g., "80.00")'),
  location: z.string().describe('City and state of the listing'),
  seller_name: z.string().describe('Seller display name'),
  image_url: z.string().describe('Primary listing photo URL'),
  is_sold: z.boolean().describe('Whether the item has been sold'),
  category_id: z.string().describe('Marketplace category ID'),
});

export interface RawMarketplaceListingNode {
  __typename?: string;
  id?: string;
  marketplace_listing_title?: string;
  listing_price?: { formatted_amount?: string; amount?: string; currency?: string };
  formatted_price?: { text?: string };
  location?: {
    reverse_geocode?: { city?: string; state?: string };
    reverse_geocode_detailed?: { city?: string; state?: string };
  };
  location_text?: { text?: string };
  marketplace_listing_seller?: { id?: string; name?: string };
  primary_listing_photo?: { image?: { uri?: string } };
  listing_photos?: Array<{ image?: { uri?: string } }>;
  is_sold?: boolean;
  marketplace_listing_category_id?: string;
  redacted_description?: { text?: string };
  description?: { text?: string };
  marketplace_listing_condition?: string;
  condition?: string;
  creation_time?: number;
}

export interface RawMarketplaceListingEdge {
  node?: { listing?: RawMarketplaceListingNode };
}

export const mapMarketplaceListing = (edge: RawMarketplaceListingEdge) => {
  const l = edge.node?.listing;
  const geo = l?.location?.reverse_geocode;
  const price = l?.listing_price?.formatted_amount ?? l?.formatted_price?.text ?? '';
  return {
    id: l?.id ?? '',
    title: l?.marketplace_listing_title ?? '',
    price,
    price_amount: l?.listing_price?.amount || parseAmount(price),
    location: [geo?.city, geo?.state].filter(Boolean).join(', '),
    seller_name: l?.marketplace_listing_seller?.name ?? '',
    image_url: l?.primary_listing_photo?.image?.uri ?? '',
    is_sold: l?.is_sold ?? false,
    category_id: l?.marketplace_listing_category_id ?? '',
  };
};

// ---------------------------------------------------------------------------
// Marketplace listing — detail (used by get_listing)
// ---------------------------------------------------------------------------

export const marketplaceListingDetailSchema = marketplaceListingSchema.extend({
  url: z.string().describe('Public listing URL'),
  description: z.string().describe('Full listing description text'),
  photo_urls: z.array(z.string()).describe('All photo URLs for the listing'),
  condition: z.string().describe('Item condition (e.g., "Used - Like new"); empty if unspecified'),
  seller_id: z.string().describe('Seller user ID'),
  created_at: z.number().int().describe('Unix timestamp when the listing was created (0 if unknown)'),
});

export const mapMarketplaceListingDetail = (l: RawMarketplaceListingNode | undefined | null) => {
  const node = l ?? {};
  const geo = node.location?.reverse_geocode_detailed ?? node.location?.reverse_geocode;
  const photos = (node.listing_photos ?? []).map(p => p?.image?.uri ?? '').filter(Boolean);
  const primary = node.primary_listing_photo?.image?.uri ?? photos[0] ?? '';
  const formattedPrice = node.listing_price?.formatted_amount ?? node.formatted_price?.text ?? '';
  const rawAmount = node.listing_price?.amount ?? '';
  return {
    id: node.id ?? '',
    title: node.marketplace_listing_title ?? '',
    price: formattedPrice,
    price_amount: rawAmount || parseAmount(formattedPrice),
    location: [geo?.city, geo?.state].filter(Boolean).join(', ') || node.location_text?.text || '',
    seller_name: node.marketplace_listing_seller?.name ?? '',
    seller_id: node.marketplace_listing_seller?.id ?? '',
    image_url: primary,
    photo_urls: photos.length ? photos : primary ? [primary] : [],
    is_sold: node.is_sold ?? false,
    category_id: node.marketplace_listing_category_id ?? '',
    description: node.description?.text ?? node.redacted_description?.text ?? '',
    condition: node.condition ?? node.marketplace_listing_condition ?? '',
    url: node.id ? `https://www.facebook.com/marketplace/item/${node.id}/` : '',
    created_at: node.creation_time ?? 0,
  };
};

const parseAmount = (formatted: string): string => {
  const m = formatted.match(/[\d,]+(?:\.\d+)?/);
  return m ? m[0].replace(/,/g, '') : '';
};
