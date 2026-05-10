# Facebook Marketplace Plugin (OpenTabs)

## Preferences

- **GitHub access**: use the `gh` CLI (e.g.
  `gh api repos/opentabs-dev/opentabs/contents/plugins/facebook`) instead of
  WebFetch against github.com / api.github.com / raw.githubusercontent.com.
- **OpenTabs docs**: the live site at `opentabs.dev/docs` is just a render of
  `docs/content/docs/` in the `opentabs-dev/opentabs` repo. Read docs via
  `gh api repos/opentabs-dev/opentabs/contents/docs/content/docs` (with
  `-H 'Accept: application/vnd.github.raw'` for file contents) — do **not**
  WebFetch the docs site.
- **JSON manipulation**: use `jq` for slicing / filtering / counting JSON. Don't
  pipe to `python3 -c` for simple JSON tasks.

## Development

Edit → build → discover → test, all from the terminal. No MCP client needed.

### Build

- `npm run build` — compile + bundle. Auto-registers in
  `~/.opentabs/config.json` (first time) and pings the MCP server to hot-reload
  the adapter into matching tabs.
- `npm run dev` — watch mode for the same.
- `npm run check` — build + type-check + lint + format:check. Use before
  committing.

The first time the plugin registers, the user must flip it from **Off** to
**Ask** in the OpenTabs Chrome side panel — otherwise `opentabs tool call` won't
dispatch.

### Discover

When you don't know the GraphQL op / variables / response shape, capture it from
the live page. OpenTabs ships browser tools that do this inline. The user flips
the **Browser** plugin to **Ask** in the side panel (one-time), then:

1. `opentabs tool call browser_list_tabs '{}'` → find the FB tab's id.
2. `opentabs tool call browser_enable_network_capture '{"tabId": <id>, "urlFilter": "graphql"}'`
   — start capture (the filter cuts noise to GraphQL only).
3. **User triggers the action in the FB UI** (scroll, click a listing, change a
   filter…). That's what fires the request you want to see.
4. `opentabs tool call browser_get_network_requests '{"tabId": <id>}'` —
   inspect. The `fb_api_req_friendly_name` form param is the operation name;
   URL-encoded `variables` shows the shape; `responseBody` is the decoded JSON.
   Pipe through `jq` to extract exactly what you need.
5. `opentabs tool call browser_disable_network_capture '{"tabId": <id>}'` —
   clean up.

Other useful browser tools: `browser_execute_script` (run JS in the page MAIN
world — the same context our adapter runs in), `browser_get_page_html`,
`browser_navigate_tab`. List them all with `opentabs tool list | grep browser_`.

### Test

- `opentabs tool list --plugin facebook-marketplace` — confirm registration.
- `opentabs tool schema <plugin>_<tool>` — view input schema.
- `opentabs tool call <plugin>_<tool> '<json>'` — invoke. Tool names are
  plugin-prefixed (`facebook-marketplace_my_listings`). Pass `'{}'` for no-input
  tools.
- `opentabs logs --plugin facebook-marketplace` — read `log.debug` / `log.info`
  from the handler. Useful for inspecting intermediate state without bloating
  the tool's response.

## Gotchas

Non-obvious FB / Relay things that took time to discover — keep these in mind
when adding new tools:

- **Doc-IDs auto-resolve via `fbRequire(<OpName>_facebookRelayOperation)`** for
  any operation module already loaded in the page. The `populateFromSSRScripts`
  regex also catches `{queryID, queryName}` triples in SSR HTML.
  Pagination/refetch ops only become resolvable after the user has navigated to
  a page that loads them.
- **SSR pages contain _multiple_ Relay fragments about the same entity**, each
  with a different field subset (one fragment carries price+photos, another
  carries description+seller, etc.). For detail-page tools, collect _all_
  fragments matching the target id and **merge** by id — don't pick a single
  "best" fragment. Filter on `__typename` (e.g., `GroupCommerceProductItem`)
  instead of requiring a specific field like `marketplace_listing_title`, since
  slim fragments may omit it.
- **The `Fast` query family caps `count` server-side at ~10.** To paginate
  further, use the corresponding `*PaginationQuery` operation with `cursor` from
  each `edges[i].cursor` (per-edge, not connection-level `page_info`). Stop on
  no-cursor / no-progress. Both queries hit the same connection
  (`viewer.marketplace_listing_sets`) and share most variables.
