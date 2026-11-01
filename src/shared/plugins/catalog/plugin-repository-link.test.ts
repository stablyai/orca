import { describe, expect, it } from 'vitest'
import {
  pluginListingRepositoryUrl,
  pluginReadmePageUrl,
  pluginRepositoryPageUrl
} from './plugin-repository-link'

describe('pluginRepositoryPageUrl', () => {
  it('builds the repository page from the https or ssh install URL', () => {
    expect(pluginRepositoryPageUrl('https://github.com/Acme/Gleam.git')).toBe(
      'https://github.com/acme/gleam'
    )
    expect(pluginRepositoryPageUrl('git@gitlab.com:acme/tools/notes.git')).toBe(
      'https://gitlab.com/acme/tools/notes'
    )
  })

  it('drops credentials, ports, queries and fragments from the URL it was given', () => {
    expect(pluginRepositoryPageUrl('https://user:token@github.com:443/acme/gleam?x=1#y')).toBe(
      'https://github.com/acme/gleam'
    )
  })

  it('refuses other hosts, schemes and odd path segments', () => {
    for (const url of [
      'https://evil.example/acme/gleam',
      'https://github.com.evil.example/acme/gleam',
      'javascript:alert(1)//github.com/acme/gleam',
      'data:text/html,<a>',
      'http://github.com/acme/gleam',
      'https://github.com/acme/%2e%2e',
      'https://github.com/acme'
    ]) {
      expect(pluginRepositoryPageUrl(url)).toBeNull()
    }
  })
})

describe('pluginReadmePageUrl', () => {
  const commit = 'a'.repeat(40)

  it('links the plugin folder at the pinned commit', () => {
    expect(pluginReadmePageUrl({ gitUrl: 'https://github.com/Acme/Plugins.git', commit })).toBe(
      `https://github.com/acme/plugins/tree/${commit}#readme`
    )
    expect(
      pluginReadmePageUrl({
        gitUrl: 'https://github.com/acme/plugins',
        commit,
        path: 'themes/gleam'
      })
    ).toBe(`https://github.com/acme/plugins/tree/${commit}/themes/gleam#readme`)
    expect(pluginReadmePageUrl({ gitUrl: 'git@gitlab.com:acme/tools/notes.git', commit })).toBe(
      `https://gitlab.com/acme/tools/notes/-/tree/${commit}#readme`
    )
  })

  it('refuses unpinned commits, odd paths and unlinkable hosts', () => {
    const gitUrl = 'https://github.com/acme/plugins'
    expect(pluginReadmePageUrl({ gitUrl, commit: 'main' })).toBeNull()
    expect(pluginReadmePageUrl({ gitUrl, commit, path: 'a/../b' })).toBeNull()
    expect(pluginReadmePageUrl({ gitUrl, commit, path: 'a/%2e%2e' })).toBeNull()
    expect(pluginReadmePageUrl({ gitUrl: 'https://evil.example/acme/x', commit })).toBeNull()
  })
})

describe('pluginListingRepositoryUrl', () => {
  const mirror = { url: 'https://github.com/stablyai/orca-community-mirror.git' }

  it("links the author's repository a mirrored listing records", () => {
    expect(
      pluginListingRepositoryUrl({
        pluginKey: 'dawidwetzler.cobalt2-theme',
        source: mirror,
        release: { repository: 'https://github.com/DawidWetzler/orca-cobalt2-theme' }
      })
    ).toBe('https://github.com/DawidWetzler/orca-cobalt2-theme')
  })

  it('falls back to the mirror once the catalog marks the source unavailable', () => {
    expect(
      pluginListingRepositoryUrl({
        pluginKey: 'acme.notes',
        source: mirror,
        release: { repository: 'https://github.com/acme/notes', sourceUnavailable: true }
      })
    ).toBe(mirror.url)
  })

  it("never links a recorded repository outside the publisher's namespace or linkable hosts", () => {
    for (const repository of [
      'https://github.com/someone-else/notes',
      'https://evil.example/acme/notes',
      'https://github.com/acme/%2e%2e'
    ]) {
      expect(
        pluginListingRepositoryUrl({
          pluginKey: 'acme.notes',
          source: mirror,
          release: { repository }
        })
      ).toBe(mirror.url)
    }
    expect(pluginListingRepositoryUrl({ pluginKey: 'acme.notes', source: mirror })).toBe(mirror.url)
  })
})
