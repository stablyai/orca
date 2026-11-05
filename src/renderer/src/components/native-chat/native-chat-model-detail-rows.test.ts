import { describe, expect, it } from 'vitest'
import { nativeChatModelDetailRows } from './native-chat-model-detail-rows'

describe('nativeChatModelDetailRows', () => {
  it('gives each stated fact a row in card order and none to unknown facts', () => {
    expect(
      nativeChatModelDetailRows({ contextWindowTokens: 200_000, provider: 'openrouter' }).map(
        ({ id, value }) => [id, value]
      )
    ).toEqual([
      ['provider', 'openrouter'],
      ['context', expect.stringContaining('200k')]
    ])
    // A stated lack of reasoning is a fact; an unstated one is not.
    expect(nativeChatModelDetailRows({ reasoning: false }).map(({ id }) => id)).toEqual([
      'reasoning'
    ])
    expect(nativeChatModelDetailRows({ free: true })).toEqual([])
  })
})
