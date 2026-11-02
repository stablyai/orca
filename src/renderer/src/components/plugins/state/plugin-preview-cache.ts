import type { PluginMarketplaceHostListing } from '../../../../../preload/api-types'
import type { PluginPagePreview } from './use-plugin-catalog'

/** Plugins whose preview one Settings visit keeps; each holds a parsed manifest. */
export const PLUGIN_PREVIEW_CACHE_CAP = 32

type Entry = { commit: string; request: Promise<PluginPagePreview> }

function pluginId(listing: PluginMarketplaceHostListing): string {
  return `${listing.marketplaceSourceId}:${listing.pluginKey}`
}

/**
 * One preview per plugin, for the catalog revision last seen: a newer revision replaces the
 * older one, a refresh drops revisions the catalog no longer lists, and the least recently
 * used plugin goes past the cap. Callers keep the promise they got, so eviction never
 * changes a preview already on screen or approved.
 */
export class PluginPreviewCache {
  private readonly entries = new Map<string, Entry>()
  // Why: a page pinned to an older listing must not displace the current revision's preview.
  private currentCommits = new Map<string, string>()

  constructor(
    private readonly load: (listing: PluginMarketplaceHostListing) => Promise<PluginPagePreview>
  ) {}

  get size(): number {
    return this.entries.size
  }

  fetch(listing: PluginMarketplaceHostListing): Promise<PluginPagePreview> {
    const id = pluginId(listing)
    const commit = listing.marketplaceCommit
    const cached = this.entries.get(id)
    if (cached?.commit === commit) {
      this.entries.delete(id)
      this.entries.set(id, cached)
      return cached.request
    }
    const request = this.load(listing).then((result) => {
      // Why: only successes are cached, so Retry asks again.
      if (!result.ok && this.entries.get(id)?.request === request) {
        this.entries.delete(id)
      }
      return result
    })
    const current = this.currentCommits.get(id)
    if (current === undefined || current === commit) {
      this.entries.delete(id)
      this.entries.set(id, { commit, request })
      for (const oldest of this.entries.keys()) {
        if (this.entries.size <= PLUGIN_PREVIEW_CACHE_CAP) {
          break
        }
        this.entries.delete(oldest)
      }
    }
    return request
  }

  /** Records the catalog's current revisions and drops previews of any other. */
  retainListed(listings: readonly PluginMarketplaceHostListing[]): void {
    this.currentCommits = new Map(
      listings.map((listing) => [pluginId(listing), listing.marketplaceCommit])
    )
    for (const [id, entry] of this.entries) {
      if (this.currentCommits.get(id) !== entry.commit) {
        this.entries.delete(id)
      }
    }
  }
}
