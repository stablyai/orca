import { describe, expect, it } from 'vitest'
import { pluginListingRepositoryUrl, pluginRepositoryPageUrl } from './plugin-repository-link'

describe('pluginRepositoryPageUrl', () => {
  it('drops credentials, ports, queries and fragments from the URL it was given', () => {
    expect(pluginRepositoryPageUrl('https://user:token@github.com:443/acme/gleam?x=1#y')).toBe(
      'https://github.com/acme/gleam'
    )
  })
})

describe('pluginListingRepositoryUrl', () => {
  const mirror = { url: 'https://github.com/stablyai/orca-community-mirror.git' }

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
