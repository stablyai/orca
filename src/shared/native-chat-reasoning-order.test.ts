import { expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import {
  compareNativeChatTranscriptMessages,
  projectNativeChatTranscriptMessages
} from './native-chat-transcript-projection'

function row(id: string, role: NativeChatMessage['role'], timestamp = 1): NativeChatMessage {
  return { id, role, timestamp, source: 'transcript', blocks: [{ type: 'text', text: id }] }
}

it('keeps derived reasoning immediately before its answer without changing provider timestamps', () => {
  const messages = [
    row('opencode:msg_b', 'assistant'),
    row('opencode:msg_a:other', 'assistant'),
    row('opencode:msg_a', 'assistant'),
    row('opencode:msg_b:reasoning', 'reasoning'),
    row('opencode:msg_a:reasoning', 'reasoning')
  ]
  const sorted = [...messages].sort(compareNativeChatTranscriptMessages)
  expect(sorted.map((message) => message.id)).toEqual([
    'opencode:msg_a:reasoning',
    'opencode:msg_a',
    'opencode:msg_a:other',
    'opencode:msg_b:reasoning',
    'opencode:msg_b'
  ])
  expect(projectNativeChatTranscriptMessages(messages)).toEqual(sorted)
  expect(messages.every((message) => message.timestamp === 1)).toBe(true)
  for (let first = 0; first < sorted.length; first++) {
    for (let second = first + 1; second < sorted.length; second++) {
      expect(compareNativeChatTranscriptMessages(sorted[first], sorted[second])).toBeLessThan(0)
      expect(compareNativeChatTranscriptMessages(sorted[second], sorted[first])).toBeGreaterThan(0)
    }
  }
})

it('keeps timestamp and journal authority ahead of a derived reasoning key', () => {
  const answer = row('row', 'assistant', 1)
  const laterReasoning = row('row:reasoning', 'reasoning', 2)
  expect(compareNativeChatTranscriptMessages(answer, laterReasoning)).toBeLessThan(0)
  answer.journalPosition = { sequence: 1, index: 0 }
  laterReasoning.journalPosition = { sequence: 2, index: 0 }
  laterReasoning.timestamp = 0
  expect(compareNativeChatTranscriptMessages(answer, laterReasoning)).toBeLessThan(0)
})

it('keeps provider step order and reasoning pairs together at a timestamp tie', () => {
  const user = { ...row('9', 'user'), transcriptPosition: 9, timestampPrecision: 'second' as const }
  const answer = { ...row('10', 'assistant'), transcriptPosition: 10 }
  const reasoning = { ...row('10:reasoning', 'reasoning'), transcriptPosition: 10 }
  const messages = [answer, reasoning, user]
  const sorted = [...messages].sort(compareNativeChatTranscriptMessages)
  expect(sorted).toEqual([user, reasoning, answer])
  expect(projectNativeChatTranscriptMessages(messages)).toEqual(sorted)
  expect(sorted[0]).toBe(user)
  expect(sorted[0].timestampPrecision).toBe('second')
  for (let first = 0; first < sorted.length; first++) {
    for (let second = first + 1; second < sorted.length; second++) {
      expect(compareNativeChatTranscriptMessages(sorted[first], sorted[second])).toBeLessThan(0)
      expect(compareNativeChatTranscriptMessages(sorted[second], sorted[first])).toBeGreaterThan(0)
    }
  }
})
