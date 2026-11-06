import { describe, expect, it } from 'vitest'
import type { PluginHostListEntry } from '../../../../../preload/api-types'
import {
  pluginListEntryFromInstalled,
  pluginListEntryFromListing
} from '../list/plugin-list-entries'
import { pluginAuthor, pluginAuthorCatalogId, pluginsBySamePublisher } from './plugin-author'
import {
  pluginAuthorGithubUrl,
  pluginSourceGitUrl,
  pluginSourceReadmeUrl
} from './plugin-source-links'

function listed(pluginKey: string, url: string, marketplaceSourceId = 'community') {
  return pluginListEntryFromListing({
    pluginKey,
    marketplaceSourceId,
    marketplaceName: 'Community',
    marketplaceOwner: 'catalog-owner',
    marketplaceCommit: 'abc',
    source: { kind: 'git', url, ref: 'main' },
    categories: [],
    official: false,
    bundled: false
  })
}

function installed(
  source: Pick<NonNullable<PluginHostListEntry['source']>, 'kind' | 'reference'> &
    Partial<NonNullable<PluginHostListEntry['source']>>,
  isDev = false
) {
  return pluginListEntryFromInstalled(
    {
      pluginKey: 'acme.notes',
      name: 'Notes',
      publisher: 'acme',
      version: '1.0.0',
      status: 'running',
      consentFingerprint: null,
      needsReconsent: false,
      isDev,
      official: false,
      bundled: false,
      capabilities: [],
      panels: [],
      commands: [],
      hasWorker: false,
      restarts: 0,
      source: { resolvedCommit: null, contentHash: 'b'.repeat(64), ...source }
    },
    listed('acme.notes', 'https://github.com/acme/notes').listing
  )
}

describe('plugin publisher and source provenance', () => {
  it('links GitHub publishers only when the repository owner matches the publisher', () => {
    expect(pluginAuthorGithubUrl(listed('acme.notes', 'https://github.com/Acme/notes.git'))).toBe(
      'https://github.com/acme'
    )
    expect(pluginAuthorGithubUrl(listed('acme.notes', 'git@github.com:acme/notes.git'))).toBe(
      'https://github.com/acme'
    )
    expect(
      pluginAuthorGithubUrl(listed('victim.notes', 'https://github.com/mirror/notes'))
    ).toBeNull()
    expect(pluginAuthorGithubUrl(listed('acme.notes', 'https://gitlab.com/acme/notes'))).toBeNull()
    expect(
      pluginAuthorGithubUrl(installed({ kind: 'local-path', reference: '/plugins/notes' }))
    ).toBeNull()
  })

  it('recommends only the same publisher label within the same catalog', () => {
    const entry = listed('acme.notes', 'https://github.com/acme/notes')
    const entries = {
      installed: [],
      available: [
        listed('acme.icons', 'https://github.com/Acme/icons'),
        listed('acme.other-host', 'https://gitlab.com/acme/other'),
        listed('acme.other-catalog', 'https://github.com/acme/other', 'unrelated')
      ]
    }
    expect(pluginsBySamePublisher(entry, entries).map((item) => item.pluginKey)).toEqual([
      'acme.icons',
      'acme.other-host'
    ])
  })

  it('keeps installed mirror authors and recommendations tied to the recorded release', () => {
    const entry = installed({
      kind: 'marketplace',
      reference: 'https://github.com/mirrors/plugins.git (plugins/notes)',
      url: 'https://github.com/mirrors/plugins.git',
      path: 'plugins/notes',
      authorRepository: 'https://github.com/acme/notes',
      marketplace: {
        reference: 'https://github.com/catalog/plugins',
        resolvedCommit: 'a'.repeat(40)
      }
    })
    const other = {
      ...entry,
      pluginKey: 'acme.icons',
      installed: { ...entry.installed!, pluginKey: 'acme.icons' }
    }
    expect(pluginAuthor(entry)).toEqual({
      publisher: 'acme',
      catalog: 'Community',
      provenance: 'catalog'
    })
    expect(pluginSourceGitUrl(entry)).toBe('https://github.com/acme/notes')
    expect(
      pluginsBySamePublisher(entry, { installed: [other], available: [] }).map(
        (item) => item.pluginKey
      )
    ).toEqual(['acme.icons'])
    // A newer catalog record must not replace the installed release's attribution.
    const withoutListing = { ...entry, listing: null, updatable: false }
    expect(pluginSourceGitUrl(withoutListing)).toBe('https://github.com/acme/notes')
    expect(pluginAuthorCatalogId(withoutListing)).toBeNull()
  })

  it('uses structured monorepo sources instead of parsing their display label', () => {
    const entry = installed({
      kind: 'marketplace',
      reference: 'https://github.com/acme/plugins.git (plugins/notes)',
      url: 'https://github.com/acme/plugins.git',
      path: 'plugins/notes'
    })
    expect(pluginSourceGitUrl(entry)).toBe('https://github.com/acme/plugins.git')
  })

  it('revokes a recorded repository only when the installed catalog release marks it unavailable', () => {
    const entry = installed({
      kind: 'marketplace',
      reference: 'https://github.com/mirrors/plugins.git',
      url: 'https://github.com/mirrors/plugins.git',
      resolvedCommit: 'a'.repeat(40),
      authorRepository: 'https://github.com/acme/notes',
      marketplace: {
        reference: 'https://github.com/catalog/plugins',
        resolvedCommit: 'c'.repeat(40)
      }
    })
    entry.listing = {
      ...entry.listing!,
      source: { kind: 'git', url: 'https://github.com/mirrors/plugins.git', ref: 'main' },
      release: {
        version: '1.0.0',
        commit: 'a'.repeat(40),
        contentHash: 'b'.repeat(64),
        execution: 'data',
        minimumOrca: '1.0.0',
        repository: 'https://github.com/acme/notes',
        sourceUnavailable: true
      }
    }
    expect(pluginSourceGitUrl(entry)).toBe('https://github.com/mirrors/plugins.git')
    expect(pluginSourceGitUrl({ ...entry, listing: null })).toBe('https://github.com/acme/notes')
    expect(pluginSourceGitUrl({ ...entry, updatable: false })).toBe('https://github.com/acme/notes')
    entry.listing.release!.commit = 'd'.repeat(40)
    expect(pluginSourceGitUrl(entry)).toBe('https://github.com/acme/notes')
  })

  it('borrows a catalog repository only from a source and release matched listing', () => {
    const entry = installed({
      kind: 'marketplace',
      reference: 'Mirror · Notes',
      url: 'https://github.com/mirrors/plugins.git',
      path: 'plugins/notes',
      resolvedCommit: 'a'.repeat(40),
      marketplace: {
        reference: 'https://github.com/catalog/plugins',
        resolvedCommit: 'c'.repeat(40)
      }
    })
    entry.listing = {
      ...entry.listing!,
      source: {
        kind: 'git',
        url: 'https://github.com/mirrors/plugins.git',
        ref: 'main',
        path: 'plugins/notes'
      },
      release: {
        version: '1.0.0',
        commit: 'a'.repeat(40),
        contentHash: 'b'.repeat(64),
        execution: 'data',
        minimumOrca: '1.0.0',
        repository: 'https://github.com/acme/notes'
      }
    }
    for (const listing of [
      { ...entry.listing, source: { ...entry.listing.source, path: 'plugins/other' } },
      {
        ...entry.listing,
        source: { ...entry.listing.source, url: 'https://github.com/other/plugins' }
      },
      { ...entry.listing, release: { ...entry.listing.release!, commit: 'd'.repeat(40) } },
      { ...entry.listing, release: { ...entry.listing.release!, contentHash: 'e'.repeat(64) } },
      { ...entry.listing, release: { ...entry.listing.release!, sourceUnavailable: true as const } }
    ]) {
      expect(pluginSourceGitUrl({ ...entry, listing })).toBe(
        'https://github.com/mirrors/plugins.git'
      )
    }
    expect(pluginSourceGitUrl({ ...entry, updatable: false })).toBe(
      'https://github.com/mirrors/plugins.git'
    )
  })

  it('keeps a mirror catalog claim separate from an account identity', () => {
    const entry = listed('victim.plugin', 'https://github.com/mirror/plugins')
    entry.listing!.release = {
      version: '1.0.0',
      commit: 'a'.repeat(40),
      contentHash: 'b'.repeat(64),
      execution: 'data',
      minimumOrca: '1.0.0',
      repository: 'https://github.com/victim/repo'
    }
    expect(pluginAuthor(entry)).toEqual({
      publisher: 'victim',
      catalog: 'Community',
      provenance: 'catalog'
    })
  })

  it.each([
    {
      reference: 'https://github.com/acme/notes',
      url: 'https://github.com/acme/notes',
      path: undefined,
      readme: 'https://github.com/acme/notes/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#readme'
    },
    {
      reference: 'https://github.com/acme/plugins (plugins/notes)',
      url: 'https://github.com/acme/plugins',
      path: 'plugins/notes',
      readme:
        'https://github.com/acme/plugins/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plugins/notes#readme'
    }
  ])(
    'restores older-host links only for the recorded location $reference',
    ({ reference, path, url, readme }) => {
      const entry = installed({
        kind: 'marketplace',
        reference,
        resolvedCommit: 'a'.repeat(40),
        marketplace: {
          reference: 'https://github.com/catalog/plugins',
          resolvedCommit: 'c'.repeat(40)
        }
      })
      entry.listing!.source = { kind: 'git', url, ref: 'main', path }
      expect(pluginSourceGitUrl(entry)).toBe(url)
      expect(pluginSourceReadmeUrl(entry)).toBe(readme)
      expect(pluginSourceGitUrl({ ...entry, updatable: false })).toBeNull()
      expect(pluginSourceGitUrl({ ...entry, listing: null })).toBeNull()
      entry.listing!.source.path = 'plugins/other'
      expect(pluginSourceGitUrl(entry)).toBeNull()
      expect(pluginSourceReadmeUrl(entry)).toBeNull()
    }
  )

  it('links an installed mirror README at its recorded path and commit, even after catalog changes', () => {
    const entry = installed({
      kind: 'marketplace',
      reference: 'mirror',
      url: 'https://gitlab.com/mirror/plugins',
      path: 'plugins/notes',
      resolvedCommit: 'a'.repeat(40),
      authorRepository: 'https://github.com/acme/notes'
    })
    expect(pluginSourceReadmeUrl(entry)).toBe(
      'https://gitlab.com/mirror/plugins/-/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plugins/notes#readme'
    )
    expect(pluginSourceReadmeUrl({ ...entry, listing: null })).toBe(
      'https://gitlab.com/mirror/plugins/-/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plugins/notes#readme'
    )
    entry.installed!.source!.resolvedCommit = null
    expect(pluginSourceReadmeUrl(entry)).toBeNull()
  })

  it('does not borrow a listing profile or repository for local and dev installs', () => {
    for (const isDev of [true, false]) {
      const entry = installed({ kind: 'local-path', reference: '/plugins/notes' }, isDev)
      expect(pluginSourceGitUrl(entry)).toBeNull()
    }
  })

  it('uses a Git install source even when an unrelated listing is attached', () => {
    const entry = installed({ kind: 'git', reference: 'https://gitlab.com/acme/notes' })
    expect(pluginSourceGitUrl(entry)).toBe('https://gitlab.com/acme/notes')
    expect(pluginAuthor(entry)).toEqual({ publisher: 'acme', catalog: null, provenance: 'git' })
    expect(pluginAuthor({ ...entry, listing: null })).toEqual({
      publisher: 'acme',
      catalog: null,
      provenance: 'git'
    })
  })

  it('attributes local and dev publisher labels to the manifest', () => {
    for (const isDev of [true, false]) {
      const entry = installed({ kind: 'local-path', reference: '/plugins/notes' }, isDev)
      expect(pluginAuthor(entry)).toEqual({
        publisher: 'acme',
        catalog: null,
        provenance: 'manifest'
      })
    }
  })

  it('keeps unnamed catalog and unknown install sources distinct', () => {
    const entry = installed({ kind: 'marketplace', reference: 'catalog' })
    entry.listing = null
    expect(pluginAuthor(entry)).toEqual({
      publisher: 'acme',
      catalog: null,
      provenance: 'catalog'
    })
    entry.installed!.source = undefined
    expect(pluginAuthor(entry)).toEqual({
      publisher: 'acme',
      catalog: null,
      provenance: 'unknown'
    })
  })
})
