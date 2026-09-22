import { describe, expect, it } from 'vitest'
import { pairNativeChatToolResults } from './native-chat-tool-pairing'
import type {
  NativeChatBlock,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from './native-chat-types'

const call = (name: string): NativeChatToolCallBlock => ({ type: 'tool-call', name, input: {} })
const result = (output: string): NativeChatToolResultBlock => ({ type: 'tool-result', output })

describe('pairNativeChatToolResults', () => {
  it('gives each call the result that answered it', () => {
    const [a, ra, b, rb] = [call('read'), result('one'), call('shell'), result('two')]
    const { resultByCall, pairedResults } = pairNativeChatToolResults([a, ra, b, rb])

    expect(resultByCall.get(a)).toBe(ra)
    expect(resultByCall.get(b)).toBe(rb)
    expect(pairedResults.size).toBe(2)
  })

  it('answers the oldest unanswered call when two are interleaved', () => {
    const [outer, inner, first, second] = [call('a'), call('b'), result('inner'), result('outer')]
    const { resultByCall } = pairNativeChatToolResults([outer, inner, first, second])

    expect(resultByCall.get(outer)).toBe(first)
    expect(resultByCall.get(inner)).toBe(second)
  })

  it('leaves a still-running call without a result', () => {
    const [a, b, only] = [call('a'), call('b'), result('one')]
    const { resultByCall } = pairNativeChatToolResults([a, b, only])

    expect(resultByCall.get(a)).toBe(only)
    expect(resultByCall.has(b)).toBe(false)
  })

  it('leaves a result with no call to answer unpaired, so it still draws its own row', () => {
    const orphan = result('one')
    const { resultByCall, pairedResults } = pairNativeChatToolResults([orphan])

    expect(resultByCall.size).toBe(0)
    expect(pairedResults.has(orphan)).toBe(false)
  })

  it('ignores blocks that are neither a call nor a result', () => {
    const text: NativeChatBlock = { type: 'text', text: 'hi' }
    const [a, ra] = [call('a'), result('r')]
    const { resultByCall } = pairNativeChatToolResults([text, a, ra])

    expect(resultByCall.get(a)).toBe(ra)
  })
})
