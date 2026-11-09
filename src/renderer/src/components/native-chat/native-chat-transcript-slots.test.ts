import { describe, expect, it } from 'vitest'

import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'

import type { NativeChatTurnStatus } from '../../../../shared/native-chat/transcript/native-chat-turn-status'

import type { NativeChatResolvedPrompt } from '../../../../shared/native-chat/native-chat-resolution-receipt'
import type { NativeChatTurnDiff } from '../../../../shared/native-chat/tools/native-chat-turn-diffs'
import {
  buildNativeChatTranscriptSlots,
  type NativeChatMessageSlot
} from './native-chat-transcript-slots'

const NO_STATUSES = { active: null, completedByTurn: {} }

function text(id: string, body: string, role: NativeChatMessage['role'] = 'assistant') {
  return {
    id,
    role,
    blocks: [{ type: 'text' as const, text: body }],
    timestamp: 1,
    source: 'transcript' as const
  }
}

function build(
  messages: NativeChatMessage[],
  overrides: Partial<Parameters<typeof buildNativeChatTranscriptSlots>[0]> = {}
): NativeChatMessageSlot[] {
  let turn: string | undefined
  const turnKeys = messages.map((message) => {
    if (message.role === 'user') {
      turn = message.id
    }
    return turn
  })
  return buildNativeChatTranscriptSlots({
    messages,
    turnKeys,
    liveTurnKey: undefined,
    receipts: new Map<string, NativeChatResolvedPrompt>(),
    turnStatuses: NO_STATUSES,
    turnDiffs: new Map<string, NativeChatTurnDiff>(),
    expandedTurnKeys: new Set<string>(),
    isWorking: false,
    lifecycleWorking: false,
    ...overrides
  }).filter((slot): slot is NativeChatMessageSlot => slot.kind === 'message')
}

function toolRun(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'tool-call', name: 'shell', input: { command: 'ls' }, state: 'completed' }],
    timestamp: 1,
    source: 'transcript'
  }
}

describe('transcript slots', () => {
  it("marks a row as continuing its turn only when the agent's next step follows", () => {
    const continuing = (messages: NativeChatMessage[]) =>
      build(messages)
        .filter((slot) => slot.continuesTurn)
        .map((slot) => slot.message.id)

    expect(continuing([text('u', 'go', 'user'), text('a', 'looking'), toolRun('b')])).toEqual([
      'u',
      'a'
    ])
    expect(
      continuing([text('u', 'go', 'user'), text('answer', 'done'), text('n', 'notice', 'system')])
    ).toEqual(['u'])
    expect(
      continuing([text('u', 'go', 'user'), text('answer', 'done'), text('u2', 'next', 'user')])
    ).toEqual(['u'])
  })

  it('keeps a message whose only content is a turn status under it', () => {
    const status: NativeChatTurnStatus = { startedAt: 1, thinking: false, workedSeconds: 4 }
    const slots = build([text('u', '', 'user')], {
      liveTurnKey: 'u',
      turnStatuses: { active: status, completedByTurn: {} }
    })
    expect(slots).toHaveLength(1)
    expect(slots[0]?.status).toBe(status)
  })
})

// Host ownership, not nearest prompt position, controls turn folds, bars and liveness.
describe('turn-owned grouping', () => {
  // The #23621 shape: B lands mid-turn, three tool calls follow, one turn.

  it("rolls a turn's diff up once, under its last row, when another prompt lands among its rows", () => {
    // B opens its own turn but was sent before A's last row was written.
    const messages = [
      text('A', 'go', 'user'),
      toolRun('t1'),
      text('B', 'next', 'user'),
      text('a-answer', 'Done with A.'),
      toolRun('b1')
    ]
    const diff = (added: number): NativeChatTurnDiff => ({
      files: [],
      added,
      removed: 0,
      truncated: false
    })
    const slots = build(messages, {
      turnKeys: ['A', 'A', 'B', 'A', 'B'],
      turnDiffs: new Map([
        ['A', diff(1)],
        ['B', diff(2)]
      ])
    })
    expect(
      slots.filter((slot) => slot.turnDiff).map((slot) => [slot.message.id, slot.turnDiff?.added])
    ).toEqual([
      ['a-answer', 1],
      ['b1', 2]
    ])
  })

  it('skips only the open reasoning the live line discloses, and only while it does', () => {
    const reasoning = (id: string, state: 'running' | 'completed'): NativeChatMessage => ({
      ...text(id, 'Weighing two approaches', 'reasoning'),
      state
    })
    const live = { turnKeys: ['A', 'A', 'A'], liveTurnKey: 'A', isWorking: true }
    const rows = [text('A', 'go', 'user'), reasoning('r-1', 'running'), reasoning('r-2', 'running')]
    const ids = (overrides: Partial<Parameters<typeof build>[1]>) =>
      build(rows, { ...live, ...overrides }).map((slot) => slot.message.id)
    expect(ids({ liveReasoningId: 'r-2' })).toEqual(['A', 'r-1'])
    // Nothing discloses it (a prompt took the line, or it says something else): it draws.
    expect(ids({ liveReasoningId: null })).toEqual(['A', 'r-1', 'r-2'])
    expect(ids({})).toEqual(['A', 'r-1', 'r-2'])
  })
})
