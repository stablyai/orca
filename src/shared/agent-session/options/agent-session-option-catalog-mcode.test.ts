import { describe, expect, it } from 'vitest'
import { mcodeCliModelFromId } from './agent-session-option-catalog-mcode'

describe('mcodeCliModelFromId', () => {
  it('maps a builtin provider id to provider/model#variant', () => {
    expect(mcodeCliModelFromId('m:minimax:MiniMax-M3.1-Flash:v:thinking')).toBe(
      'minimax/MiniMax-M3.1-Flash#thinking'
    )
  })

  it('drops the variant suffix when thinking is off', () => {
    expect(mcodeCliModelFromId('m:minimax:MiniMax-M3:v:')).toBe('minimax/MiniMax-M3')
  })

  it('keeps a custom provider compound identity through the slash form', () => {
    expect(mcodeCliModelFromId('m:custom_provider:minimax-legacy:MiniMax-M2.7:v:thinking')).toBe(
      'custom_provider:minimax-legacy/MiniMax-M2.7#thinking'
    )
  })

  it('passes through ids outside the mcode scheme untouched', () => {
    expect(mcodeCliModelFromId('some-model')).toBe('some-model')
  })
})
