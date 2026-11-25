import type { PluginMarketplaceHostListing } from '../../../../../preload/api/plugins/plugin-host-api'
import type { PluginPagePreview } from './use-plugin-catalog'

/** Plugins whose preview one Settings visit keeps; each holds a parsed manifest. */
export const PLUGIN_PREVIEW_CACHE_CAP = 32

type Entry = { revision: string; request: Promise<PluginPagePreview> }

export function pluginPreviewCatalogRevision(
  entry: Pick<PluginMarketplaceHostListing, 'marketplaceCommit' | 'managedByTeams'>
): string {
  return JSON.stringify([entry.marketplaceCommit, entry.managedByTeams])
}

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
  private currentRevisions = new Map<string, string>()

  constructor(
    private readonly load: (listing: PluginMarketplaceHostListing) => Promise<PluginPagePreview>
  ) {}

  get size(): number {
    return this.entries.size
  }

  fetch(listing: PluginMarketplaceHostListing): Promise<PluginPagePreview> {
    const id = pluginId(listing)
    const revision = pluginPreviewCatalogRevision(listing)
    const cached = this.entries.get(id)
    if (cached?.revision === revision) {
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
    const current = this.currentRevisions.get(id)
    if (current === undefined || current === revision) {
      this.entries.delete(id)
      this.entries.set(id, { revision, request })
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
    this.currentRevisions = new Map(
      listings.map((listing) => [pluginId(listing), pluginPreviewCatalogRevision(listing)])
    )
    for (const [id, entry] of this.entries) {
      if (this.currentRevisions.get(id) !== entry.revision) {
        this.entries.delete(id)
      }
    }
  }
}
