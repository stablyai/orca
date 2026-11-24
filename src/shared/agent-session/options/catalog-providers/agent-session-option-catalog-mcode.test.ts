import { describe, expect, it } from 'vitest'
import {
  mcodeCliModelFromId,
  mcodeModelId,
  parseMcodeModelId
} from './agent-session-option-catalog-mcode'

describe('mcode model ids', () => {
  it('reads a selection id back into the CLI spelling mcode accepts', () => {
    const legacy = { providerId: 'custom_provider:minimax-legacy', modelId: 'MiniMax-M2.7' }
    // mcode percent-encodes each part, so a compound provider id adds no colon to the id.
    const thinking = mcodeModelId({ ...legacy, variant: 'thinking' })
    expect(thinking).toBe('m:custom_provider%3Aminimax-legacy:MiniMax-M2.7:v:thinking')
    expect(parseMcodeModelId(thinking)).toEqual({ ...legacy, variant: 'thinking' })
    expect(mcodeCliModelFromId(thinking)).toBe(
      'custom_provider:minimax-legacy/MiniMax-M2.7#thinking'
    )
    expect(mcodeCliModelFromId(mcodeModelId({ ...legacy, variant: '' }))).toBe(
      'custom_provider:minimax-legacy/MiniMax-M2.7'
    )
    expect(mcodeCliModelFromId(mcodeModelId(legacy))).toBe(
      'custom_provider:minimax-legacy/MiniMax-M2.7'
    )
  })

  it('rejects anything outside the scheme instead of guessing its parts', () => {
    // An unencoded compound provider id is also what mcode's own parser refuses.
    expect(parseMcodeModelId('m:custom_provider:minimax-legacy:MiniMax-M2.7:v:thinking')).toBeNull()
    expect(parseMcodeModelId('m:minimax:MiniMax-M3:v:thinking:extra')).toBeNull()
    expect(parseMcodeModelId('m:minimax:MiniMax-M3:u:v')).toBeNull()
    expect(parseMcodeModelId('m:minimax:MiniMax-M3:v')).toBeNull()
    expect(mcodeCliModelFromId('some-model')).toBe('some-model')
  })
})
