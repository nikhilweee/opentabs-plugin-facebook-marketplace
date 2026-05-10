import { OpenTabsPlugin, type ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { waitForAuth } from './facebook-api.js';
import { editListing } from './tools/edit-listing.js';
import { getListing } from './tools/get-listing.js';
import { listMyListings } from './tools/list-my-listings.js';

class FacebookMarketplacePlugin extends OpenTabsPlugin {
  readonly name = 'facebook-marketplace';
  readonly description = 'OpenTabs plugin for Facebook Marketplace';
  override readonly displayName = 'Facebook Marketplace';
  readonly urlPatterns = ['*://*.facebook.com/*'];
  readonly tools: ToolDefinition[] = [listMyListings, getListing, editListing];

  async isReady(): Promise<boolean> {
    return waitForAuth();
  }
}

export default new FacebookMarketplacePlugin();
