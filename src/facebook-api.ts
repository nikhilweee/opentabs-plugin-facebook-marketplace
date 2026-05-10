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

export const resolveDocId = (operationName: string): string => {
  const fresh = fbRequire<string>(`${operationName}_facebookRelayOperation`);
  if (fresh !== undefined) {
    getDocIdCache()[operationName] = String(fresh);
    return String(fresh);
  }
  const cached = getDocIdCache()[operationName];
  if (cached) return cached;

  throw ToolError.internal(
    `Could not resolve doc_id for ${operationName}. ` +
      'The required Relay module may not be loaded — try navigating to the relevant Facebook page first.',
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
  const docId = resolveDocId(operationName);
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
