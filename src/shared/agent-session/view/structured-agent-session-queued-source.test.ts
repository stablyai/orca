import { expect, it, vi } from 'vitest'
import type * as MessageSourceModule from '../agent-session-message-source'
import {
  agentMessageSenderName,
  type AgentMessageSender,
  type AgentMessageSource
} from '../agent-session-message-source'
import { agentMessageSenderLabel } from '../agent-message-presentation'
import type { AgentSessionQueuedMessage } from '../requests/agent-session-queued-message-wire'
import { projectQueuedMessageCards } from './structured-agent-session-queued-cards'

vi.mock('../agent-session-message-source', async (importOriginal) => {
  const original = await importOriginal<typeof MessageSourceModule>()
  return { ...original, agentMessageSenderName: vi.fn(original.agentMessageSenderName) }
})

const LONG_LABEL =
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
const normalizations = vi.mocked(agentMessageSenderName)

function sender(address: string): AgentMessageSender {
  return Object.freeze({
    party: Object.freeze({ address, terminalHandle: null, orcaSessionId: null }),
    name: null
  })
}

function source(address: string): AgentMessageSource {
  return { kind: 'agent', senders: [sender(address)], orchestration: null }
}

function label(value: AgentMessageSender, snapshotName: string | null = null): string {
  return agentMessageSenderLabel({
    sender: value,
    snapshotName,
    localChat: false,
    fallback: 'an agent'
  })
}

function queuedLabels(message: AgentSessionQueuedMessage, queuePaused = false) {
  return projectQueuedMessageCards([message], [], { queuePaused }).map((card) => {
    const value = card.from?.senders[0]
    return { label: value ? label(value, value.name) : null, hold: card.hold }
  })
}

it('normalizes retained sender addresses once, including invisible inputs, behind current names', () => {
  for (const [address, expected] of [
    ['x'.repeat(1_000), LONG_LABEL],
    ['x'.repeat(10_000), LONG_LABEL],
    ['\u200B'.repeat(10_000), '—'],
    [`${'\u200B'.repeat(10_000)}orca-bg-wake`, 'orca-bg-wake'],
    [' \u202eX\uD800\u200DY😀\nZ ', 'X\u200DY😀 Z']
  ]) {
    normalizations.mockClear()
    const value = sender(address)
    expect(label(value, 'Saved command')).toBe('Saved command')
    expect(normalizations).not.toHaveBeenCalled()
    for (let read = 0; read < 5; read++) {
      expect(label(value)).toBe(expected)
    }
    expect(label(value, 'Renamed command')).toBe('Renamed command')
    expect(label(value)).toBe(expected)
    expect(normalizations.mock.calls.map(([input]) => String(input).length)).toEqual([
      address.length
    ])
  }
})

it('reuses unchanged queued provenance and refreshes changed, removed and replacement sources', () => {
  for (const size of [1_000, 10_000]) {
    normalizations.mockClear()
    const original = source('x'.repeat(size))
    const message: AgentSessionQueuedMessage = {
      messageId: 'command',
      position: 1,
      state: 'waiting',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Background command completed' }],
        from: original
      }
    }
    for (let rebuild = 0; rebuild < 5; rebuild++) {
      const queuePaused = rebuild % 2 === 0
      const cards = queuedLabels(message, queuePaused)
      expect(cards.map((card) => [card.label, card.hold])).toEqual([
        [LONG_LABEL, queuePaused ? 'queue-paused' : 'turn']
      ])
    }
    expect(normalizations.mock.calls.map(([input]) => String(input).length)).toEqual([size])
    message.body.from = source('changed-source')
    expect(queuedLabels(message)[0]?.label).toBe('changed-source')
    expect(normalizations).toHaveBeenCalledTimes(2)
    message.body.from = undefined
    expect(queuedLabels(message)[0]?.label).toBeNull()
    expect(normalizations).toHaveBeenCalledTimes(2)
    message.body.from = original
    expect(queuedLabels(message)[0]?.label).toBe(LONG_LABEL)
    expect(normalizations).toHaveBeenCalledTimes(3)
    const replaced = { ...message, body: { ...message.body, from: source('replacement-source') } }
    expect(queuedLabels(replaced)[0]?.label).toBe('replacement-source')
    expect(normalizations).toHaveBeenCalledTimes(4)
  }
})
