import { describe, expect, it } from 'vitest'
import type {
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing
} from '../../../../../preload/api/plugins/plugin-host-api'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'
import { catalogInstallTrustPrompt } from './plugin-install-trust'

function makeListing(
  overrides: Partial<PluginMarketplaceHostListing> = {}
): PluginMarketplaceHostListing {
  return {
    marketplaceSourceId: 'community',
    marketplaceName: 'Orca Community Plugins',
    marketplaceOwner: 'stablyai',
    marketplaceCommit: 'a'.repeat(40),
    pluginKey: 'ebbop.italiano',
    source: {
      kind: 'git',
      url: 'https://github.com/stablyai/orca-community-mirror.git',
      ref: 'refs/tags/ebbop/orca-italiano/1.4.261'
    },
    categories: ['language-packs'],
    official: false,
    bundled: false,
    version: '1.4.261',
    repository: 'https://github.com/Ebbop/orca-italiano',
    updatedAt: '2026-11-18T00:08:04+01:00',
    release: {
      version: '1.4.261',
      commit: 'b'.repeat(40),
      contentHash: 'c'.repeat(64),
      execution: 'data',
      minimumOrca: '1.4.246',
      repository: 'https://github.com/Ebbop/orca-italiano',
      updatedAt: '2026-11-18T00:08:04+01:00',
      contributes: [{ kind: 'languagePacks', name: 'it' }]
    },
    ...overrides
  }
}

function makePreview(listing: PluginMarketplaceHostListing): PluginMarketplaceHostInstallPreview {
  return {
    marketplaceSourceId: listing.marketplaceSourceId,
    marketplaceName: listing.marketplaceName,
    marketplaceOwner: listing.marketplaceOwner,
    marketplaceCommit: listing.marketplaceCommit,
    pluginKey: listing.pluginKey,
    source: listing.source,
    resolvedCommit: 'b'.repeat(40),
    contentHash: 'c'.repeat(64),
    consentFingerprint: 'd'.repeat(64),
    official: false,
    bundled: false,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 2,
      id: listing.pluginKey.split('.')[1] ?? 'italiano',
      name: 'Italiano',
      version: '1.4.261',
      execution: 'data',
      engines: { orca: '>=1.4.246' },
      capabilities: [],
      contributes: {
        languagePacks: [{ locale: 'it', path: 'locales/it.json' }]
      }
    })
  }
}

describe('catalogInstallTrustPrompt', () => {
  it('unwinds the community mirror to the author repository and links the public plugin page', () => {
    const listing = makeListing()
    const prompt = catalogInstallTrustPrompt(
      listing,
      makePreview(listing),
      'https://github.com/stablyai/orca-community-plugins.git'
    )

    expect(prompt).toEqual({
      kind: 'translations',
      trustee: 'Ebbop',
      publisher: 'ebbop',
      version: '1.4.261',
      updatedAt: '2026-11-18T00:08:04+01:00',
      installCountPluginKey: 'ebbop.italiano',
      repository: 'github.com/ebbop/orca-italiano',
      repositoryUrl: 'https://github.com/ebbop/orca-italiano',
      pluginPageUrl: 'https://orca.dev/plugins/ebbop.italiano?catalog=community',
      location: 'Orca Community Plugins',
      access: []
    })
  })

  it('never names stablyai as the trustee when a mirrored community source repo is unavailable', () => {
    const base = makeListing()
    const listing = makeListing({
      release: { ...base.release!, sourceUnavailable: true }
    })
    const prompt = catalogInstallTrustPrompt(
      listing,
      makePreview(listing),
      'https://github.com/stablyai/orca-community-plugins.git'
    )

    expect(prompt?.trustee).toBe('ebbop')
    expect(prompt?.repositoryUrl).toBeNull()
  })

  it('keeps the fetched repository and hides public links/counts for third-party catalogs', () => {
    const listing = makeListing({
      marketplaceSourceId: 'custom',
      marketplaceName: 'Custom Catalog',
      marketplaceOwner: 'mallory',
      pluginKey: 'ebbop.italiano',
      source: {
        kind: 'git',
        url: 'https://github.com/mallory/backdoor.git',
        ref: 'main'
      }
    })
    const prompt = catalogInstallTrustPrompt(
      listing,
      makePreview(listing),
      'https://github.com/mallory/catalog.git'
    )

    expect(prompt?.trustee).toBe('mallory')
    expect(prompt?.repository).toBe('github.com/mallory/backdoor')
    expect(prompt?.repositoryUrl).toBe('https://github.com/mallory/backdoor')
    expect(prompt?.pluginPageUrl).toBeNull()
    expect(prompt?.installCountPluginKey).toBeNull()
  })

  it('does not unwind the community mirror or trust pluginKey for a third-party catalog pointing at the mirror', () => {
    const listing = makeListing({
      marketplaceSourceId: 'custom',
      marketplaceName: 'Custom Catalog',
      marketplaceOwner: 'mallory',
      pluginKey: 'torvalds.italiano'
    })
    const prompt = catalogInstallTrustPrompt(
      listing,
      makePreview(listing),
      'https://github.com/mallory/catalog.git'
    )

    expect(prompt?.trustee).toBe('stablyai')
    expect(prompt?.repository).toBe('github.com/stablyai/orca-community-mirror')
    expect(prompt?.repositoryUrl).toBe('https://github.com/stablyai/orca-community-mirror')
    expect(prompt?.pluginPageUrl).toBeNull()
    expect(prompt?.installCountPluginKey).toBeNull()
  })
})
