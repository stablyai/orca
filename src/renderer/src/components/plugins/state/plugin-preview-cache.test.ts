import { describe, expect, it, vi } from 'vitest'
import type { PluginMarketplaceHostListing } from '../../../../../preload/api-types'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_PREVIEW_CACHE_CAP, PluginPreviewCache } from './plugin-preview-cache'
import type { PluginPagePreview } from './use-plugin-catalog'

function listing(pluginKey: string, commit: string): PluginMarketplaceHostListing {
  return {
    marketplaceSourceId: 'source',
    marketplaceName: 'Catalog',
    marketplaceOwner: 'acme',
    marketplaceCommit: commit,
    pluginKey,
    source: { kind: 'git', url: 'https://example.invalid/p.git', ref: 'main' },
    categories: [],
    official: false,
    bundled: false
  }
}

const manifest = pluginManifestSchema.parse({
  manifestVersion: 1,
  id: 'dusk',
  publisher: 'acme',
  name: 'Dusk',
  version: '1.0.0',
  engines: { orca: '>=1.0.0' },
  pluginApi: 1,
  contributes: { themes: [{ id: 'dusk', title: 'Dusk', path: 'themes/dusk.json' }] }
})

function setup(): { cache: PluginPreviewCache; load: ReturnType<typeof vi.fn> } {
  const load = vi.fn(async (entry: PluginMarketplaceHostListing): Promise<PluginPagePreview> => ({
    ok: true,
    preview: {
      ...entry,
      resolvedCommit: 'c'.repeat(40),
      contentHash: 'd'.repeat(64),
      consentFingerprint: 'sha256-shown',
      manifest
    }
  }))
  return { cache: new PluginPreviewCache(load), load }
}

describe('PluginPreviewCache', () => {
  it('keeps one preview per plugin across revisions, bounded overall', async () => {
    const { cache, load } = setup()
    for (let revision = 0; revision < 10; revision++) {
      const latest = listing('a', `c${revision}`)
      cache.retainListed([latest])
      await cache.fetch(latest)
    }
    expect(cache.size).toBe(1)
    await cache.fetch(listing('a', 'c9'))
    expect(load).toHaveBeenCalledTimes(10)

    cache.retainListed([])
    for (let index = 0; index < PLUGIN_PREVIEW_CACHE_CAP * 2; index++) {
      await cache.fetch(listing(`p${index}`, 'c'))
    }
    expect(cache.size).toBe(PLUGIN_PREVIEW_CACHE_CAP)
  })

  it('does not let a pinned older revision displace the current one', async () => {
    const { cache, load } = setup()
    const current = listing('a', 'new')
    cache.retainListed([current])
    await cache.fetch(current)
    await cache.fetch(listing('a', 'old'))
    await cache.fetch(current)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
