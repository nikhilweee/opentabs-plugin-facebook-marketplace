import { OpenTabsPlugin, type ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { waitForAuth } from './facebook-api.js';
import { createListing } from './tools/create-listing.js';
import { editListing } from './tools/edit-listing.js';
import { getListing } from './tools/get-listing.js';
import { myListings } from './tools/my-listings.js';

class FacebookMarketplacePlugin extends OpenTabsPlugin {
  readonly name = 'facebook-marketplace';
  readonly description = 'OpenTabs plugin for Facebook Marketplace';
  override readonly displayName = 'Facebook Marketplace';
  readonly urlPatterns = ['*://*.facebook.com/*'];
  readonly tools: ToolDefinition[] = [myListings, getListing, editListing, createListing];

  async isReady(): Promise<boolean> {
    return waitForAuth();
  }
}

export default new FacebookMarketplacePlugin();
