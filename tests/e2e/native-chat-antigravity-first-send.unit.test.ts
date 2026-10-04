// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../src/shared/native-chat-types'
import { decodeAntigravityTranscriptLine } from '../../src/main/native-chat/transcript-line-decoders-antigravity'
import { decodeClaudeTranscriptLine } from '../../src/main/native-chat/transcript-line-decoders-claude'
import { decodeCodexTranscriptLine } from '../../src/main/native-chat/transcript-line-decoders-codex'
import { assembleNativeChatSession } from '../../src/renderer/src/components/native-chat/native-chat-session-assembler'
import { parseRuntimeNativeChatReadSessionResult } from '../../src/renderer/src/components/native-chat/native-chat-runtime-contract'
import { prepareNativeChatLiveMessages } from '../../src/renderer/src/components/native-chat/native-chat-live-message-preparation'
import {
  appendPendingSendCache,
  clearPendingSendCacheForTests,
  launchPromptAsMessage,
  shouldPruneLaunchPrompt,
  pendingSendsAsMessages,
  prunePendingSends
} from '../../src/renderer/src/components/native-chat/native-chat-pending'
import { useNativeChatPendingDelivery } from '../../src/renderer/src/components/native-chat/use-native-chat-pending-delivery'

const captured = readFileSync(
  resolve('src/main/native-chat/__fixtures__/antigravity/live-timestamp-tie.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line, index) => {
    const message = decodeAntigravityTranscriptLine(line, `line-${index}`)
    if (!message) {
      throw new Error('Expected captured Antigravity row')
    }
    return message
  })
const user = captured[0]!
const reply = captured[1]!
const second = user.timestamp!
const text = user.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(' ')
const firstSend = { id: 'first', text, sentAt: second + 300, afterMessageId: null }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(firstSend.sentAt)
  clearPendingSendCacheForTests()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('hides the first echo at user-only flush, retains it over an empty read, then retires on reply', () => {
  const initialMessages: NativeChatMessage[] = []
  const { result, rerender } = renderHook(
    ({ messages }: { messages: NativeChatMessage[] }) =>
      useNativeChatPendingDelivery({ paneKey: 'agy-pane', agent: 'antigravity', messages }),
    { initialProps: { messages: initialMessages } }
  )
  act(() => result.current.record(text))
  expect(pendingSendsAsMessages(result.current.pending, [])).toHaveLength(1)
  const visibleUser = prepareNativeChatLiveMessages([user], 'antigravity')
  rerender({ messages: visibleUser })
  expect(pendingSendsAsMessages(result.current.pending, visibleUser)).toEqual([])
  expect(result.current.pending).toHaveLength(1)
  rerender({ messages: [] })
  expect(pendingSendsAsMessages(result.current.pending, [])).toHaveLength(1)
  rerender({
    messages: assembleNativeChatSession({
      sources: { transcript: [reply, user] },
      agent: 'antigravity',
      sessionId: 'captured'
    }).messages
  })
  expect(result.current.pending).toEqual([])
})

it('excludes earlier seconds and preserves strict transcript boundaries after paging', () => {
  const old = captured.map((message) => ({ ...message, timestamp: second - 1000 }))
  expect(prunePendingSends([firstSend], old)).toEqual([firstSend])
  const paged = { ...firstSend, afterMessageId: 'paged-out', afterMessageTimestamp: second }
  expect(prunePendingSends([paged], captured)).toEqual([paged])
  expect(pendingSendsAsMessages([paged], captured)).toHaveLength(1)
})

it('does not let one coarse transcript occurrence consume two identical sends', () => {
  const scope = { paneKey: 'agy-pane', agent: 'antigravity' }
  appendPendingSendCache(scope, firstSend)
  const pending = appendPendingSendCache(scope, {
    ...firstSend,
    id: 'second',
    sentAt: second + 700
  })
  const remaining = prunePendingSends(pending, captured)
  expect(remaining.map((entry) => entry.id)).toEqual(['second'])
  expect(pendingSendsAsMessages(remaining, captured).map((message) => message.id)).toEqual([
    'pending:second'
  ])
})

it.each(['claude', 'codex'] as const)(
  'keeps exact .000 %s history from claiming a later send',
  (agent) => {
    const timestamp = new Date(second).toISOString()
    const record =
      agent === 'claude'
        ? { type: 'user', uuid: 'old', timestamp, message: { role: 'user', content: text } }
        : {
            type: 'response_item',
            timestamp,
            payload: { type: 'message', role: 'user', content: [{ type: 'text', text }] }
          }
    const decode = agent === 'claude' ? decodeClaudeTranscriptLine : decodeCodexTranscriptLine
    const precise = decode(JSON.stringify(record), 'old')
    if (!precise) {
      throw new Error('Expected precise provider row')
    }
    const history = [precise, { ...reply, id: 'old-answer' }]
    expect(precise.timestamp).toBe(second)
    expect(prunePendingSends([firstSend], history)).toEqual([firstSend])
    expect(pendingSendsAsMessages([firstSend], history)).toHaveLength(1)
  }
)

it('also reconciles the seeded launch prompt against the captured first turn', () => {
  const launch = {
    tabId: 'agy-launch',
    agent: 'antigravity' as const,
    text,
    createdAt: firstSend.sentAt
  }
  expect(launchPromptAsMessage(launch, [user])).toBeNull()
  expect(shouldPruneLaunchPrompt(launch, [user])).toBe(false)
  expect(shouldPruneLaunchPrompt(launch, captured)).toBe(true)
})

it('keeps an exact fallback timestamp at .000 from claiming a later Antigravity send', () => {
  const row = decodeAntigravityTranscriptLine(
    JSON.stringify({
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: text,
      timestamp: new Date(second).toISOString()
    }),
    'precise-fallback'
  )
  if (!row) {
    throw new Error('Expected fallback timestamp row')
  }
  expect(row.timestampPrecision).toBeUndefined()
  expect(pendingSendsAsMessages([firstSend], [row])).toHaveLength(1)
})

it('preserves explicitly millisecond numeric Antigravity created_at even at .000', () => {
  const row = decodeAntigravityTranscriptLine(
    JSON.stringify({
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: text,
      created_at: second
    }),
    'precise-numeric'
  )
  if (!row) {
    throw new Error('Expected numeric timestamp row')
  }
  expect(row.timestampPrecision).toBeUndefined()
  expect(pendingSendsAsMessages([firstSend], [row])).toHaveLength(1)
})

it('carries coarse precision across JSON reads and remains conservative when an older host omits it', () => {
  const read = parseRuntimeNativeChatReadSessionResult(
    JSON.parse(JSON.stringify({ messages: captured }))
  )
  if (!('messages' in read)) {
    throw new Error('Expected transported transcript')
  }
  expect(prunePendingSends([firstSend], read.messages)).toEqual([])
  const legacy = read.messages.map((message) => ({ ...message, timestampPrecision: undefined }))
  expect(prunePendingSends([firstSend], legacy)).toEqual([firstSend])
})
