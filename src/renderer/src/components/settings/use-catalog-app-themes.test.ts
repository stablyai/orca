import { describe, expect, it } from 'vitest'
import type { PluginMarketplaceHostListing } from '../../../../preload/api-types'
import { catalogAppThemes } from './use-catalog-app-themes'

function themeListing(
  pluginKey: string,
  release: Partial<NonNullable<PluginMarketplaceHostListing['release']>> = {}
): PluginMarketplaceHostListing {
  return {
    marketplaceSourceId: 'official',
    marketplaceName: 'Orca Official Plugins',
    marketplaceOwner: 'stablyai',
    marketplaceCommit: 'abc123',
    pluginKey,
    source: { kind: 'git', url: 'https://example.invalid/plugins.git', ref: 'main' },
    categories: ['themes'],
    official: true,
    bundled: false,
    release: {
      version: '1.0.0',
      commit: 'd'.repeat(40),
      contentHash: 'e'.repeat(64),
      execution: 'data',
      minimumOrca: '1.4.245',
      types: [],
      themePreview: [
        {
          label: 'Night',
          base: 'dark',
          background: '#000000',
          foreground: '#ffffff',
          accent: '#336699',
          surface: '#111111'
        },
        {
          label: 'Day',
          base: 'light',
          background: '#ffffff',
          foreground: '#000000',
          accent: '#336699',
          surface: '#eeeeee'
        }
      ],
      ...release
    }
  }
}

describe('catalogAppThemes', () => {
  it('offers only one-click themes for the slot mode that are not installed and run here', () => {
    const snapshot = {
      installed: [],
      orcaVersion: '1.4.246',
      listings: [
        themeListing('stablyai.offered'),
        themeListing('stablyai.installed'),
        themeListing('stablyai.code', { execution: 'trusted-worker' }),
        themeListing('stablyai.too-new', { minimumOrca: '9.0.0' })
      ]
    }

    const offered = catalogAppThemes(snapshot, 'dark', new Set(['stablyai.installed']))

    expect(offered.map((theme) => [theme.listing.pluginKey, theme.label])).toEqual([
      ['stablyai.offered', 'Night']
    ])
  })
})
