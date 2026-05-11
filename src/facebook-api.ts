import {
  ToolError,
  clearAuthCache,
  fetchFromPage,
  getAuthCache,
  httpStatusToToolError,
  log,
  setAuthCache,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';

// ---------------------------------------------------------------------------
// Facebook internal module access
// ---------------------------------------------------------------------------

const fbRequire = <T = unknown>(moduleName: string): T | undefined => {
  try {
    const req = (globalThis as Record<string, unknown>).require as ((name: string) => T) | undefined;
    if (typeof req !== 'function') return undefined;
    return req(moduleName);
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

interface FacebookAuth {
  userId: string;
  fbDtsg: string;
  lsd: string;
}

const getAuth = (): FacebookAuth | null => {
  const cached = getAuthCache<FacebookAuth>('facebook');
  if (cached?.userId && cached?.fbDtsg && cached?.lsd) return cached;

  const userId = fbRequire<{ USER_ID?: string }>('CurrentUserInitialData')?.USER_ID;
  const fbDtsg = fbRequire<{ token?: string }>('DTSGInitialData')?.token;
  const lsd = fbRequire<{ token?: string }>('LSD')?.token;

  if (!userId || !fbDtsg || !lsd) return null;

  const auth: FacebookAuth = { userId, fbDtsg, lsd };
  setAuthCache('facebook', auth);
  return auth;
};

export const isAuthenticated = (): boolean => getAuth() !== null;

export const getCurrentUserId = (): string | null => getAuth()?.userId ?? null;

// Capped at 3000 ms because the OpenTabs extension treats isReady() as
// failed after 5 s; leave headroom for the surrounding plumbing.
export const waitForAuth = async (): Promise<boolean> => {
  try {
    await waitUntil(() => isAuthenticated(), { interval: 500, timeout: 3000 });
    return true;
  } catch {
    return false;
  }
};

const requireAuth = (): FacebookAuth => {
  const auth = getAuth();
  if (!auth) throw ToolError.auth('Not authenticated — please log in to Facebook.');
  return auth;
};

// ---------------------------------------------------------------------------
// Doc ID resolution
// ---------------------------------------------------------------------------

const getDocIdCache = (): Record<string, string> => {
  const g = globalThis as Record<string, unknown>;
  if (!g.__fbDocIdCache || typeof g.__fbDocIdCache !== 'object') {
    g.__fbDocIdCache = {};
  }
  return g.__fbDocIdCache as Record<string, string>;
};

const populateFromSSRScripts = (cache: Record<string, string>): void => {
  if (typeof document === 'undefined') return;
  const scripts = document.querySelectorAll('script');
  const pattern =
    /"queryID"\s*:\s*"(\d{10,})"\s*,\s*"variables"\s*:\s*\{[^}]*\}\s*,\s*"queryName"\s*:\s*"([A-Za-z]+(?:Query|Mutation))"/g;
  for (const script of scripts) {
    const text = script.textContent ?? '';
    for (const match of text.matchAll(pattern)) {
      const queryId = match[1];
      const queryName = match[2];
      if (queryName && queryId && !cache[queryName]) cache[queryName] = queryId;
    }
  }
};

// Marketplace operations our tools call directly. The resolver also picks up
// any *_facebookRelayOperation module that's been loaded plus anything found
// in SSR preloader scripts, so this list is a seed, not a hard limit.
const knownOps = [
  'CometMarketplaceYouSellingFastContentContainerQuery',
  'MarketplaceYouSellingFastActiveSectionPaginationQuery',
  'useCometMarketplaceListingEditMutation',
  'useCometMarketplaceListingCreateMutation',
  'useCometMarketplaceForSaleItemDeleteMutation',
];

const populateDocIdCache = (): void => {
  const cache = getDocIdCache();
  for (const op of knownOps) {
    if (cache[op]) continue;
    const id = fbRequire<string>(`${op}_facebookRelayOperation`);
    if (id !== undefined) cache[op] = String(id);
  }
  populateFromSSRScripts(cache);
};

populateDocIdCache();

// "Anchor" pages whose code-split bundles declare the operation modules we need.
// Order matters: composer covers create/edit + the read queries our composer-aware
// tools need; selling covers delete + pagination. Walked lazily on cache miss.
const ANCHOR_PAGES = [
  'https://www.facebook.com/marketplace/create/item',
  'https://www.facebook.com/marketplace/you/selling',
];

// Tracks which anchors we've already walked this session, so a missing op
// doesn't trigger a re-walk on every call. Stashed on globalThis so adapter
// IIFE re-injection (each tool call gets a fresh module scope) doesn't lose it.
const getWalkedAnchors = (): Set<string> => {
  const g = globalThis as Record<string, unknown>;
  if (!(g.__fbWalkedAnchors instanceof Set)) g.__fbWalkedAnchors = new Set<string>();
  return g.__fbWalkedAnchors as Set<string>;
};

const BUNDLE_URL_PATTERN = /<script[^>]+src="(https:\/\/static\.xx\.fbcdn\.net\/[^"]+\.js[^"]*)"/g;
// __d("OpName_facebookRelayOperation",[],(function(...){...exports="<docId>"}),null)
const OP_DECL_PATTERN =
  /__d\("([A-Za-z0-9_]+)_facebookRelayOperation",\[\],\(function\([^)]*\)\{[^}]*\.exports="(\d+)"\}\),null\)/g;

const walkBundlesFromAnchor = async (anchorUrl: string): Promise<void> => {
  const html = await fetchPageHtml(anchorUrl);
  const bundleUrls = Array.from(html.matchAll(BUNDLE_URL_PATTERN), m => m[1]).filter(
    (u): u is string => typeof u === 'string',
  );
  log.debug('doc_id:walk_anchor', { anchor: anchorUrl, bundles: bundleUrls.length });

  const cache = getDocIdCache();
  await Promise.all(
    bundleUrls.map(async url => {
      try {
        // Plain fetch (no credentials) — these are public CDN bundles with
        // permissive CORS; credentialed fetch is rejected.
        const resp = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(30_000) });
        if (!resp.ok) return;
        const body = await resp.text();
        for (const m of body.matchAll(OP_DECL_PATTERN)) {
          const name = m[1];
          const id = m[2];
          if (name && id && !cache[name]) cache[name] = id;
        }
      } catch (e) {
        log.debug('doc_id:bundle_fetch_failed', { url: url.slice(0, 80), error: String(e) });
      }
    }),
  );
};

// Resolve a doc_id for an operation name. Fast path uses the in-page Relay
// module registry and the cache; slow path fetches anchor pages and walks their
// code-split JS bundles to recover declarations that haven't been lazy-loaded.
// The slow path is gated by `walkedAnchors` so we only walk each anchor once
// per session.
export const resolveDocId = async (operationName: string): Promise<string> => {
  const fresh = fbRequire<string>(`${operationName}_facebookRelayOperation`);
  if (fresh !== undefined) {
    getDocIdCache()[operationName] = String(fresh);
    return String(fresh);
  }
  let cached = getDocIdCache()[operationName];
  if (cached) return cached;

  const walked = getWalkedAnchors();
  for (const anchor of ANCHOR_PAGES) {
    if (walked.has(anchor)) continue;
    walked.add(anchor);
    await walkBundlesFromAnchor(anchor);
    cached = getDocIdCache()[operationName];
    if (cached) return cached;
  }

  throw ToolError.internal(
    `Could not resolve doc_id for ${operationName} after walking anchor bundles. ` +
      'Facebook may have reorganized its bundle layout — see CLAUDE.md "doc_id resolution".',
  );
};

// ---------------------------------------------------------------------------
// GraphQL caller
// ---------------------------------------------------------------------------

export const graphql = async <T = unknown>(
  operationName: string,
  variables: Record<string, unknown> = {},
): Promise<T> => {
  const auth = requireAuth();
  const docId = await resolveDocId(operationName);
  log.debug('graphql:request', { operationName, docId });

  const body = new URLSearchParams({
    av: auth.userId,
    __user: auth.userId,
    __a: '1',
    __comet_req: '15',
    fb_dtsg: auth.fbDtsg,
    lsd: auth.lsd,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: operationName,
    variables: JSON.stringify(variables),
    server_timestamps: 'true',
    doc_id: docId,
  });

  const resp = await fetchFromPage('/api/graphql/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-FB-LSD': auth.lsd,
      'X-FB-Friendly-Name': operationName,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      clearAuthCache('facebook');
      throw ToolError.auth('Facebook session expired — please log in again.');
    }
    throw httpStatusToToolError(resp, `Facebook API returned HTTP ${resp.status}.`);
  }

  const text = await resp.text();
  // Anti-XSSI prefix; some endpoints also stream multiple JSON lines (NDJSON).
  const cleaned = text.replace(/^for \(;;\);/, '');
  const lines = cleaned.split('\n').filter(Boolean);
  const parsed = lines.map(line => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  });
  const first = parsed.find(p => p !== null);
  if (!first) throw ToolError.internal('Empty response from Facebook GraphQL API.');

  const errors = first.errors as Array<{ message?: string; code?: number }> | undefined;
  const hasData = first.data !== undefined && first.data !== null;
  if (errors?.length && !hasData) {
    const msg = errors[0]?.message ?? 'Unknown GraphQL error';
    const code = errors[0]?.code;
    if (code === 1675039) throw ToolError.validation(`Query blocked: ${msg}`);
    if (msg.includes('not authenticated') || msg.includes('session') || code === 190) {
      clearAuthCache('facebook');
      throw ToolError.auth(msg);
    }
    throw ToolError.internal(`Facebook GraphQL error: ${msg}`);
  }

  return (first.data ?? first) as T;
};

// ---------------------------------------------------------------------------
// Photo upload (non-GraphQL — multipart to upload.facebook.com)
// ---------------------------------------------------------------------------

// Upload a Blob to Facebook's composer photo endpoint. Returns the photoID
// suitable for use in marketplace listing mutations' `photo_ids` field.
// `targetId` is the destination marketplace's id (from
// viewer.marketplace_settings.current_marketplace.id).
const uploadPhotoBlob = async (blob: Blob, filename: string, targetId: string): Promise<string> => {
  const auth = requireAuth();

  // Read intrinsic dimensions — FB requires them as form fields. createImageBitmap
  // is available in the page MAIN world where our adapter runs.
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();

  // jazoest is a derived anti-CSRF token: "2" + sum of fb_dtsg char codes.
  let jazoestSum = 0;
  for (let i = 0; i < auth.fbDtsg.length; i++) jazoestSum += auth.fbDtsg.charCodeAt(i);
  const jazoest = `2${jazoestSum}`;

  // The full multipart payload the FB UI sends. `farr` is the file field
  // (counter-intuitive — `source` is a separate string with value "8" that
  // tags the upload source). Required string fields: fb_dtsg, qn, target_id,
  // source, profile_id, waterfallxapp, upload_id, js_resized, plus dimension
  // metadata. Captured from FB's React composer flow.
  const formData = new FormData();
  formData.append('fb_dtsg', auth.fbDtsg);
  formData.append('qn', 'comet_marketplace_composer');
  formData.append('target_id', targetId);
  formData.append('source', '8');
  formData.append('profile_id', auth.userId);
  formData.append('waterfallxapp', 'comet');
  formData.append('farr', blob, filename);
  formData.append('upload_id', String(Date.now() % 100000));
  formData.append('js_resized', 'false');
  formData.append('original_file_size', String(blob.size));
  formData.append('original_width', String(width));
  formData.append('original_height', String(height));
  formData.append('upload_width', String(width));
  formData.append('upload_height', String(height));

  const qs = new URLSearchParams({
    av: auth.userId,
    __user: auth.userId,
    __a: '1',
    __comet_req: '15',
    fb_dtsg: auth.fbDtsg,
    jazoest,
    lsd: auth.lsd,
  });
  const url = `https://upload.facebook.com/ajax/react_composer/attachments/photo/upload?${qs.toString()}`;

  const resp = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    body: formData,
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      clearAuthCache('facebook');
      throw ToolError.auth('Photo upload unauthorized — session may have expired.');
    }
    throw httpStatusToToolError(resp, `Photo upload failed: HTTP ${resp.status}.`);
  }

  const text = await resp.text();
  const cleaned = text.replace(/^for \(;;\);/, '');
  let parsed: { payload?: { photoID?: string }; error?: { message?: string } };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    log.error('uploadPhoto:non_json_response', { preview: text.slice(0, 500) });
    throw ToolError.internal('Photo upload returned non-JSON response.');
  }
  if (parsed.error?.message) {
    log.error('uploadPhoto:fb_error', { error: parsed.error });
    throw ToolError.internal(`Photo upload error: ${parsed.error.message}`);
  }
  const photoId = parsed.payload?.photoID;
  if (!photoId) {
    log.error('uploadPhoto:no_photoid', { response_preview: cleaned.slice(0, 800) });
    throw ToolError.internal('Photo upload returned no photoID.');
  }
  return photoId;
};

// Upload a photo from base64-encoded bytes. `data` has no `data:` prefix.
export const uploadPhoto = async (data: string, mime: string, filename: string, targetId: string): Promise<string> => {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return uploadPhotoBlob(new Blob([bytes], { type: mime }), filename, targetId);
};

// Upload a photo by fetching its bytes from a URL. Used by relist_listing to
// re-upload photos from the existing listing's CDN URLs. Uses plain fetch
// without credentials — FB CDN URLs are signed and reject cross-origin
// credentialed requests.
export const uploadPhotoFromUrl = async (url: string, filename: string, targetId: string): Promise<string> => {
  const resp = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) {
    throw httpStatusToToolError(resp, `Failed to fetch photo from ${url}: HTTP ${resp.status}`);
  }
  const blob = await resp.blob();
  return uploadPhotoBlob(blob, filename, targetId);
};

// ---------------------------------------------------------------------------
// SSR / HTML scrape helpers
// ---------------------------------------------------------------------------

export const fetchPageHtml = async (url: string): Promise<string> => {
  const resp = await fetchFromPage(url, { headers: { Accept: 'text/html' } });
  if (!resp.ok) throw httpStatusToToolError(resp, `Failed to fetch ${url}: HTTP ${resp.status}`);
  return resp.text();
};

export interface RelayPayload {
  key: string;
  data: unknown;
}

export interface SSRQueryMetadata {
  queryName: string;
  queryId: string;
  variables: Record<string, unknown>;
}

// Pull the {queryID, variables, queryName} preloader records embedded in the
// SSR scripts. These are the exact requests Facebook fired server-side and
// give us the variable shape we need to paginate via `graphql()`.
export const extractSSRQueryMetadata = (html: string): SSRQueryMetadata[] => {
  const out: SSRQueryMetadata[] = [];
  const pattern =
    /"queryID"\s*:\s*"(\d{10,})"\s*,\s*"variables"\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})\s*,\s*"queryName"\s*:\s*"([A-Za-z]+(?:Query|Mutation))"/g;
  for (const m of html.matchAll(pattern)) {
    const queryId = m[1];
    const rawVars = m[2];
    const queryName = m[3];
    if (!queryId || !rawVars || !queryName) continue;
    try {
      const variables = JSON.parse(rawVars) as Record<string, unknown>;
      out.push({ queryName, queryId, variables });
    } catch {
      // Skip malformed.
    }
  }
  return out;
};

// Populate the doc_id cache from SSR-extracted query metadata. Useful when we
// fetched a page from a tool handler (so its scripts aren't in the current
// document), but still want graphql() to resolve the query's doc_id.
export const populateDocIdCacheFromMetadata = (metadata: SSRQueryMetadata[]): void => {
  const cache = getDocIdCache();
  for (const m of metadata) {
    if (!cache[m.queryName]) cache[m.queryName] = m.queryId;
  }
};

// Walk every Relay-prefetched payload and collect each fragment whose id ===
// targetId and __typename matches a Marketplace listing. Merge them: first
// non-empty value per key wins. Returns the merged fragment, or null if no
// fragments match. Caller parameterises the shape via the `T` generic.
export const findListingDetailById = <T = Record<string, unknown>>(
  payloads: Array<{ data: unknown }>,
  targetId: string,
): T | null => {
  const fragments: Array<Record<string, unknown>> = [];
  for (const p of payloads) collectMatchingListingNodes(p.data, targetId, fragments);
  if (fragments.length === 0) return null;
  const merged: Record<string, unknown> = {};
  for (const f of fragments) {
    for (const [k, v] of Object.entries(f)) {
      if (!isMeaningful(merged[k]) && isMeaningful(v)) merged[k] = v;
    }
  }
  return merged as T;
};

const LISTING_TYPENAMES = /^GroupCommerceProductItem$|^Marketplace.*Listing|MarketplaceProductItem/;

const collectMatchingListingNodes = (data: unknown, targetId: string, out: Array<Record<string, unknown>>): void => {
  if (!data || typeof data !== 'object') return;
  if (Array.isArray(data)) {
    for (const item of data) collectMatchingListingNodes(item, targetId, out);
    return;
  }
  const obj = data as Record<string, unknown>;
  if (obj.id === targetId && typeof obj.__typename === 'string' && LISTING_TYPENAMES.test(obj.__typename)) {
    out.push(obj);
  }
  for (const k of Object.keys(obj)) collectMatchingListingNodes(obj[k], targetId, out);
};

const isMeaningful = (v: unknown): boolean => {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
};

// Walkers for shared composer-SSR state (lat/lng, currency, marketplace id) —
// the seller's "Create" and "Edit" composer pages embed these in Relay
// preloader payloads at various nested paths. Each walker scans recursively.

export interface SellerLocation {
  latitude: number;
  longitude: number;
}

export const findSellLocation = (payloads: Array<{ data: unknown }>): SellerLocation | null => {
  for (const p of payloads) {
    const r = walkForKey(p.data, 'sell_location', v => {
      const obj = v as { latitude?: unknown; longitude?: unknown };
      return typeof obj.latitude === 'number' && typeof obj.longitude === 'number'
        ? { latitude: obj.latitude, longitude: obj.longitude }
        : null;
    });
    if (r) return r;
  }
  return null;
};

export const findPrimaryCurrency = (payloads: Array<{ data: unknown }>): string | null => {
  for (const p of payloads) {
    const r = walkForScalar(p.data, 'primary_currency');
    if (typeof r === 'string') return r;
  }
  return null;
};

export const findCurrentMarketplaceId = (payloads: Array<{ data: unknown }>): string | null => {
  for (const p of payloads) {
    const r = walkForKey(p.data, 'current_marketplace', v => {
      const obj = v as { id?: unknown };
      return typeof obj.id === 'string' ? obj.id : null;
    });
    if (typeof r === 'string') return r;
  }
  return null;
};

const walkForKey = <T>(v: unknown, key: string, extract: (sub: unknown) => T | null): T | null => {
  if (!v || typeof v !== 'object') return null;
  if (Array.isArray(v)) {
    for (const item of v) {
      const r = walkForKey(item, key, extract);
      if (r !== null) return r;
    }
    return null;
  }
  const obj = v as Record<string, unknown>;
  const direct = obj[key];
  if (direct && typeof direct === 'object') {
    const r = extract(direct);
    if (r !== null) return r;
  }
  for (const k of Object.keys(obj)) {
    const r = walkForKey(obj[k], key, extract);
    if (r !== null) return r;
  }
  return null;
};

const walkForScalar = (v: unknown, key: string): unknown => {
  if (!v || typeof v !== 'object') return null;
  if (Array.isArray(v)) {
    for (const item of v) {
      const r = walkForScalar(item, key);
      if (r !== null) return r;
    }
    return null;
  }
  const obj = v as Record<string, unknown>;
  if (obj[key] !== undefined && typeof obj[key] !== 'object') return obj[key];
  for (const k of Object.keys(obj)) {
    const r = walkForScalar(obj[k], key);
    if (r !== null) return r;
  }
  return null;
};

// Extract Relay-prefetched payloads embedded in SSR <script type="application/json"> tags.
// Mirrors the drill pattern used by upstream plugins/facebook/src/tools/search-marketplace.ts.
export const extractRelayPayloads = (html: string): RelayPayload[] => {
  const out: RelayPayload[] = [];
  const scriptPattern = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
  for (const m of html.matchAll(scriptPattern)) {
    const content = m[1];
    if (!content) continue;
    try {
      const parsed = JSON.parse(content) as { require?: unknown[] };
      const reqs: unknown[] = parsed.require ?? [];
      for (const req of reqs) {
        const r = req as unknown[];
        if (r[0] !== 'ScheduledServerJS') continue;
        const bboxes = (r[3] ?? []) as Array<{ __bbox?: { require?: unknown[] } }>;
        for (const bbox of bboxes) {
          const innerReqs = (bbox?.__bbox?.require ?? []) as Array<unknown[]>;
          for (const inner of innerReqs) {
            if (inner[0] !== 'RelayPrefetchedStreamCache' || inner[1] !== 'next') continue;
            const args = inner[3] as unknown[] | undefined;
            const key = args?.[0] as string | undefined;
            if (!key) continue;
            const payload = args?.[1] as { __bbox?: { result?: { data?: unknown } } } | undefined;
            const data = payload?.__bbox?.result?.data;
            if (data !== undefined) out.push({ key, data });
          }
        }
      }
    } catch {
      // Skip unparseable scripts.
    }
  }
  return out;
};
