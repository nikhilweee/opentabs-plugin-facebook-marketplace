# Facebook Marketplace

OpenTabs plugin for Facebook Marketplace — gives AI agents access to Facebook
Marketplace through your authenticated browser session.

## Install

```bash
opentabs plugin install facebook-marketplace
opentabs start  # restart if it's already running
```

> From source (for development):
>
> ```bash
> git clone https://github.com/nikhilweee/opentabs-plugin-facebook-marketplace.git
> cd opentabs-plugin-facebook-marketplace
> npm install && npm run build   # auto-registers in ~/.opentabs/config.json
> ```

## Setup

1. Open [facebook.com](https://facebook.com) in Chrome and log in.
2. Open the OpenTabs side panel — the Facebook Marketplace plugin should appear
   and you can flip it from **Off** to **Ask**.

## Tools

### Marketplace (6)

| Tool             | Description                                                                                                     | Type  |
| ---------------- | --------------------------------------------------------------------------------------------------------------- | ----- |
| `my_listings`    | Returns the current user's Marketplace listings (id, title, price, location, image, sold status, listing date). | Read  |
| `get_listing`    | Given a listing id, returns full details: title, price, description, photos, location, seller, condition.       | Read  |
| `edit_listing`   | Updates text fields (title, price, description, condition) on one of the user's own listings. Returns updated.  | Write |
| `create_listing` | Publishes a new "Item for sale" listing. Uploads photos (base64 input), then fires the create mutation.         | Write |
| `delete_listing` | Permanently deletes one of the user's listings. Irreversible. Returns the deleted id + remaining count.         | Write |
| `relist_listing` | Deletes a listing and recreates it with the same content (re-uploaded photos). Optional field overrides.        | Write |

## How It Works

This plugin runs inside your Facebook Marketplace tab through the
[OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser
session — no API tokens or OAuth apps required.

Under the hood it talks to Facebook's internal GraphQL endpoint
(`/api/graphql/`) using auth tokens extracted from the page session.
Persisted-query `doc_id`s are resolved at runtime so they survive FB's
frequent client deploys. `my_listings` cursor-paginates through the seller's
listing connection; `get_listing` merges every SSR-prefetched Relay fragment
that references the target id.

## License

MIT
