import { describe, expect, it } from 'vitest'
import { encodePluginSyntaxTokens } from './plugin-syntax-token-legend'

describe('plugin syntax token legend', () => {
  it('delta-encodes absolute quads as Monaco semantic tokens', () => {
    expect([
      ...encodePluginSyntaxTokens(new Uint32Array([0, 0, 3, 5, 0, 4, 1, 1, 2, 2, 5, 0]))
    ]).toEqual([0, 0, 3, 5, 0, 0, 4, 1, 1, 0, 2, 2, 5, 0, 0])
  })
})
