// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'
import {
  pluginManifestSchema,
  type PluginManifest
} from '../../../../../shared/plugins/manifest/plugin-manifest'
import {
  PluginUpdatePublisher,
  pluginKeyOwner,
  pluginSourceHistoryUrl
} from './PluginUpdateIdentity'

afterEach(cleanup)

const SHA = 'a'.repeat(40)

describe('pluginSourceHistoryUrl', () => {
  it('links a GitHub repository, or a folder of one, at the reviewed commit', () => {
    expect(pluginSourceHistoryUrl({ url: 'https://github.com/acme/orca-dusk.git' }, SHA)).toBe(
      `https://github.com/acme/orca-dusk/commits/${SHA}`
    )
    expect(
      pluginSourceHistoryUrl(
        { url: 'https://github.com/stablyai/orca-plugins', path: 'plugins/excalidraw' },
        SHA
      )
    ).toBe(`https://github.com/stablyai/orca-plugins/commits/${SHA}/plugins/excalidraw`)
  })

  it('links nothing for other hosts, odd URLs or a non-commit', () => {
    expect(pluginSourceHistoryUrl({ url: 'https://gitlab.com/acme/dusk.git' }, SHA)).toBeNull()
    expect(pluginSourceHistoryUrl({ url: 'https://github.com/acme/dusk/x' }, SHA)).toBeNull()
    expect(pluginSourceHistoryUrl({ url: 'https://github.com/acme/dusk' }, 'main')).toBeNull()
  })
})

describe('pluginKeyOwner', () => {
  it('reads the publisher from the catalog key', () => {
    expect(pluginKeyOwner('octocat.orca-mermaid-live')).toBe('octocat')
  })
})

function previewFor(
  pluginKey: string,
  manifest: PluginManifest,
  official: boolean
): PluginMarketplaceHostInstallPreview {
  return {
    marketplaceSourceId: 'official',
    marketplaceName: 'Orca Plugins',
    marketplaceOwner: 'stablyai',
    marketplaceCommit: 'c',
    pluginKey,
    source: { kind: 'git', url: 'https://github.com/acme/plugin.git', ref: 'v1' },
    resolvedCommit: 'r',
    contentHash: 'h',
    consentFingerprint: `reviewed-${pluginKey}`,
    manifest,
    official,
    bundled: false
  }
}

function preview(official: boolean, execution: string): PluginMarketplaceHostInstallPreview {
  return previewFor(
    'octocat.orca-mermaid-live',
    pluginManifestSchema.parse({
      manifestVersion: 2,
      id: 'orca-mermaid-live',
      publisher: 'octocat',
      name: 'Mermaid Live',
      version: '0.5.0',
      execution,
      license: 'MIT',
      engines: { orca: '>=1.4.248' },
      capabilities: [],
      ...(execution === 'trusted-worker' ? { main: 'worker.js' } : {}),
      contributes: {}
    }),
    official
  )
}

describe('PluginUpdatePublisher', () => {
  it('shows an official publisher plainly', () => {
    render(
      <TooltipProvider>
        <PluginUpdatePublisher
          pluginKey="stablyai.orca-x"
          preview={preview(true, 'trusted-worker')}
        />
      </TooltipProvider>
    )
    expect(screen.getByText('Official · stablyai')).toBeTruthy()
    expect(document.querySelector('[data-plugin-not-official]')).toBeNull()
  })

  it('marks a community plugin that runs code, with the trust advice on focus', async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <PluginUpdatePublisher
          pluginKey="octocat.orca-mermaid-live"
          preview={preview(false, 'trusted-worker')}
        />
      </TooltipProvider>
    )
    const badge = document.querySelector<HTMLElement>('[data-plugin-not-official="code"]')
    expect(badge?.textContent).toBe('Community plugin · octocat')
    fireEvent.keyDown(window, { key: 'Tab' })
    fireEvent.focus(badge!)
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      'Make sure you trust octocat before updating.'
    )
  })
})
