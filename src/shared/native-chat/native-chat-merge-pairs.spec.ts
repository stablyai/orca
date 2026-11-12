import { describe, expect, it } from 'vitest'
import {
  applyAppend,
  boundNativeChatWindow,
  createNativeChatMerger,
  replaceList
} from './native-chat-merge'
import type { NativeChatMessage } from './native-chat-types'

function row(id: string, overrides: Partial<NativeChatMessage> = {}): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'text', text: id }],
    ...overrides
  }
}

function pair(id: string): NativeChatMessage[] {
  return [row(`${id}:reasoning`, { role: 'reasoning' }), row(id)]
}

describe('native chat complete-pair windows', () => {
  it.each(['msg-provider', 'opencode:msg-provider'])('keeps the cutoff pair for %s', (id) => {
    const messages = [row('older'), ...pair(id), row('latest')]
    expect(boundNativeChatWindow(messages, 2)).toEqual(messages.slice(1))
    expect(messages.map((message) => message.id)).toEqual([
      'older',
      `${id}:reasoning`,
      id,
      'latest'
    ])
  })

  it('keeps the newest complete pair even at limit 1', () => {
    const messages = [...pair('older'), ...pair('latest')]
    expect(boundNativeChatWindow(messages, 1)).toEqual(messages.slice(2))
  })

  it('does not group unrelated reasoning, suffixes, or user rows', () => {
    const unrelated = [row('thinking', { role: 'reasoning' }), row('answer'), row('latest')]
    expect(boundNativeChatWindow(unrelated, 2)).toEqual(unrelated.slice(1))
    const suffixOnly = [row('answer:reasoning'), row('answer'), row('latest')]
    expect(boundNativeChatWindow(suffixOnly, 2)).toEqual(suffixOnly.slice(1))
    const user = [row('prompt:reasoning', { role: 'reasoning' }), row('prompt', { role: 'user' })]
    expect(boundNativeChatWindow(user, 1)).toEqual(user.slice(1))
  })

  it('keeps ordering, source precedence and cached indexes after paired trims', () => {
    const merger = createNativeChatMerger()
    const [reasoning, answer] = pair('opencode:first')
    if (!reasoning || !answer) {
      throw new Error('Expected a pair')
    }
    replaceList(merger, [row('older'), reasoning, { ...answer, source: 'hook' }])
    const authoritative = { ...answer, blocks: [{ type: 'text' as const, text: 'final answer' }] }
    const newest = row('newest')
    expect(applyAppend(merger, [authoritative, newest], 2)).toEqual([
      reasoning,
      authoritative,
      newest
    ])
    expect([...merger.indexById]).toEqual([
      [reasoning.id, 0],
      [answer.id, 1],
      ['newest', 2]
    ])
    expect(applyAppend(merger, [{ ...answer, source: 'scrape' }], 2)[1]).toBe(authoritative)
    expect(applyAppend(merger, pair('opencode:next'), 2).map((message) => message.id)).toEqual([
      'opencode:next:reasoning',
      'opencode:next'
    ])
    expect([...merger.indexById]).toEqual([
      ['opencode:next:reasoning', 0],
      ['opencode:next', 1]
    ])
  })

  it.each([1, 40, 2000])('stays at most one row above limit %i across long appends', (limit) => {
    const merger = createNativeChatMerger()
    for (let index = 0; index < limit + 20; index++) {
      const messages = applyAppend(
        merger,
        index % 2 === 0 ? pair(`opencode:${index}`) : [row(`user-${index}`, { role: 'user' })],
        limit
      )
      expect(messages.length).toBeLessThanOrEqual(limit + 1)
      expect(messages[0]?.role).not.toBe('assistant')
      expect(merger.indexById.size).toBe(messages.length)
    }
    for (let at = 0; at < merger.list.length; at++) {
      const message = merger.list[at]
      expect(merger.indexById.get(message.id)).toBe(at)
      if (message.role === 'reasoning') {
        expect(merger.list[at + 1]?.id).toBe(message.id.slice(0, -':reasoning'.length))
      } else if (message.role === 'assistant') {
        expect(merger.list[at - 1]?.id).toBe(`${message.id}:reasoning`)
      }
    }
  })
})

it('retains reasoning, answer and omission projections sharing an optional raw-row cursor', () => {
  const messages = [
    row('older'),
    ...pair('mixed').map((message) => ({ ...message, transcriptOffset: 42 })),
    row('mixed:omission', { role: 'system', transcriptOffset: 42 }),
    row('latest', { transcriptOffset: 43 })
  ]
  expect(boundNativeChatWindow(messages, 2)).toEqual(messages.slice(1))
  expect(boundNativeChatWindow(messages, 1)).toEqual(messages.slice(-1))
})
