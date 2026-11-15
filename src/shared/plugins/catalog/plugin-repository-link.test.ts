import { describe, expect, it } from 'vitest'
import { pluginRepositoryPageUrl } from './plugin-repository-link'

describe('pluginRepositoryPageUrl', () => {
  it('drops credentials, ports, queries and fragments from the URL it was given', () => {
    expect(pluginRepositoryPageUrl('https://user:token@github.com:443/acme/gleam?x=1#y')).toBe(
      'https://github.com/acme/gleam'
    )
  })
})
