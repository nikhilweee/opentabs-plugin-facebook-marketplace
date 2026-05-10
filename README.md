# Facebook Marketplace

OpenTabs plugin for Facebook Marketplace — gives AI agents access to Facebook
Marketplace through your authenticated browser session.

## Install

This plugin is not yet published. To run it locally:

```bash
git clone <this repo>
cd facebook-marketplace
npm install
npm run build   # auto-registers the plugin in ~/.opentabs/config.json
opentabs start  # restart if it's already running
```

> Once published, `opentabs plugin install facebook-marketplace` (or
> `npm install -g opentabs-plugin-facebook-marketplace`) will be the supported
> install path.

## Setup

1. Open [facebook.com](https://facebook.com) in Chrome and log in.
2. Open the OpenTabs side panel — the Facebook Marketplace plugin should appear
   and you can flip it from **Off** to **Ask**.

## Tools

### Marketplace (2)

| Tool               | Description                                                                                               | Type |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ---- |
| `list_my_listings` | Returns the current user's Marketplace listings (id, title, price, location, image, sold status).         | Read |
| `get_listing`      | Given a listing id, returns full details: title, price, description, photos, location, seller, condition. | Read |

## How It Works

This plugin runs inside your Facebook Marketplace tab through the
[OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser
session — no API tokens or OAuth apps required.

Under the hood it talks to Facebook's internal GraphQL endpoint
(`/api/graphql/`) using auth tokens (`fb_dtsg`, `lsd`, `USER_ID`) extracted from
the page's Relay modules. Persisted-query `doc_id`s are resolved at runtime via
`require('<OpName>_facebookRelayOperation')` so they survive Facebook's frequent
client deploys. `list_my_listings` cursor-paginates through the seller's listing
connection; `get_listing` reads the SSR-prefetched Relay payloads embedded in
the listing page's HTML and merges every fragment that references the target id
(each fragment carries a different subset of fields).

## License

MIT
