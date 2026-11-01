import { describe, expect, it } from 'vitest'
import type {
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing
} from '../../../../../preload/api-types'
import { isProtectedPluginTranslationPath } from '../../../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'
import en from '../../../i18n/locales/en.json'
import {
  catalogInstallTrustPrompt,
  localFolderTrustPrompt,
  pluginRepositoryOrigin,
  sourceInstallTrustPrompt
} from './plugin-install-trust'

const listing: PluginMarketplaceHostListing = {
  marketplaceSourceId: 'source',
  marketplaceName: 'Orca community',
  marketplaceOwner: 'stablyai',
  marketplaceCommit: 'b'.repeat(40),
  pluginKey: 'acme.dusk',
  source: { kind: 'git', url: 'https://github.com/Acme/dusk.git', ref: 'main' },
  categories: [],
  official: false,
  bundled: false
}

function preview(contributes: Record<string, unknown>, main?: string) {
  return {
    ...listing,
    resolvedCommit: 'c'.repeat(40),
    contentHash: 'd'.repeat(64),
    consentFingerprint: 'sha256-shown',
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      id: 'dusk',
      publisher: 'acme',
      name: 'Dusk',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      ...(main ? { main } : {}),
      contributes
    })
  } satisfies PluginMarketplaceHostInstallPreview
}

const theme = preview({ themes: [{ id: 'dusk', title: 'Dusk', path: 'themes/dusk.json' }] })

describe('catalogInstallTrustPrompt', () => {
  it('asks nothing only when both listing and preview are official', () => {
    expect(
      catalogInstallTrustPrompt({ ...listing, official: true }, { ...theme, official: true })
    ).toBeNull()
    expect(catalogInstallTrustPrompt({ ...listing, official: true }, theme)).not.toBeNull()
    expect(catalogInstallTrustPrompt(listing, { ...theme, official: true })).not.toBeNull()
  })

  it('asks for a community theme with the softer copy and the owner Orca parsed', () => {
    expect(catalogInstallTrustPrompt(listing, theme)).toEqual({
      kind: 'theme',
      trustee: 'Acme',
      publisher: 'acme',
      repository: 'github.com/acme/dusk',
      location: 'Orca community',
      access: []
    })
  })

  it('shows the publisher Orca installs as, not the one the manifest declares', () => {
    const claimed = { ...theme, manifest: { ...theme.manifest, publisher: 'stablyai' } }
    expect(catalogInstallTrustPrompt(listing, claimed)?.publisher).toBe('acme')
  })

  it('names other content and translations apart from themes', () => {
    const grammar = preview({
      syntaxes: [{ id: 'g', title: 'G', scopeName: 'source.g', path: 'g.json', extensions: ['.g'] }]
    })
    expect(catalogInstallTrustPrompt(listing, grammar)?.kind).toBe('content')
    const pack = preview({
      languagePacks: [{ locale: 'eo', path: 'eo.json' }]
    })
    expect(catalogInstallTrustPrompt(listing, pack)?.kind).toBe('translations')
  })

  it('warns a code plugin runs code and lists what it may do', () => {
    const worker = preview({}, 'dist/worker.js')
    const prompt = catalogInstallTrustPrompt(listing, worker)
    expect(prompt?.kind).toBe('code')
    expect(prompt?.access[0]).toMatch(/^Full access/)
  })

  it('treats a release the catalog calls code as code even if the manifest looks like content', () => {
    const codeRelease = {
      ...listing,
      release: {
        version: '1.0.0',
        commit: 'c'.repeat(40),
        contentHash: 'd'.repeat(64),
        execution: 'declarative' as const,
        minimumOrca: '1.0.0',
        types: []
      }
    }
    expect(catalogInstallTrustPrompt(codeRelease, theme)?.kind).toBe('code')
  })
})

describe('sourceInstallTrustPrompt', () => {
  it('names the Git owner and repository for a Git URL install', () => {
    expect(
      sourceInstallTrustPrompt({
        kind: 'git',
        url: 'git@gitlab.com:team/tools/notes.git',
        ref: 'v1'
      })
    ).toMatchObject({
      kind: 'git',
      trustee: 'team',
      publisher: 'team',
      repository: 'gitlab.com/team/tools/notes'
    })
  })

  it('calls a folder install and a development folder unverified local folders', () => {
    expect(sourceInstallTrustPrompt({ kind: 'local-path', path: '/tmp/p' })).toMatchObject({
      kind: 'local-folder',
      location: '/tmp/p'
    })
    expect(localFolderTrustPrompt('dev-folder', '/tmp/p').kind).toBe('dev-folder')
  })

  it('names a subdirectory plugin location', () => {
    expect(pluginRepositoryOrigin('https://github.com/acme/mono.git', 'plugins/dusk')).toEqual({
      owner: 'acme',
      repository: 'github.com/acme/mono (plugins/dusk)'
    })
  })
})

describe('install trust copy', () => {
  it('is copy no language pack may rewrite', () => {
    const keys = Object.keys(en.auto.components.settings.PluginInstallTrustDialog)
    expect(keys.length).toBeGreaterThan(10)
    for (const key of keys) {
      expect(
        isProtectedPluginTranslationPath(`auto.components.settings.PluginInstallTrustDialog.${key}`)
      ).toBe(true)
    }
  })
})
