import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { projectNativeChatTranscript } from '../../../../shared/native-chat-transcript-projection'
import { nativeChatTurnMembership } from '../../../../shared/native-chat-turn-membership'
import { nativeChatRowsInDrawOrder } from '../../../../shared/native-chat-turn-grouping'
import { nativeChatSubagentSections } from './native-chat-subagent-sections'
import {
  buildNativeChatTranscriptSlots,
  splitNativeChatSlotsWaitingBehindLiveTurn,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'

afterEach(() => vi.restoreAllMocks())

type Phase =
  | 'none'
  | 'command'
  | 'settled'
  | 'request'
  | 'legacy-command'
  | 'missing-command'
  | 'newer-completed'
function journal(phase: Phase): AgentJournalRenderItem[] | undefined {
  if (phase === 'none') {
    return undefined
  }
  const command = phase !== 'request' && phase !== 'missing-command'
  const user: AgentJournalRenderItem = {
    itemId: 'compact-entry',
    revision: 0,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: command ? '/compact' : 'continue' }],
      ...(command ? { command: { name: 'compact' } } : {})
    }
  }
  const turn = {
    turnId: 'compact-turn',
    userItemId: user.itemId,
    state: phase === 'settled' ? 'completed' : 'running'
  } as const
  const items: AgentJournalRenderItem[] = [
    user,
    {
      itemId: 'compact-turn',
      revision: 0,
      sequence: 2,
      observedAt: 2,
      body:
        phase === 'legacy-command'
          ? { kind: 'status', text: 'Running', turnLifecycle: turn }
          : { kind: 'turn', ...turn }
    }
  ]
  if (phase === 'missing-command') {
    items.shift()
  }
  if (phase === 'newer-completed') {
    items.push({
      itemId: 'newer',
      revision: 0,
      sequence: 3,
      observedAt: 3,
      body: { kind: 'turn', turnId: 'newer', state: 'completed' }
    })
  }
  return items
}
function messages(count: number, seed = 0): NativeChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${seed}-${index % (seed % 3 === 0 ? Math.max(1, count - 1) : count)}`,
    role: index % 3 === 0 ? 'user' : 'assistant',
    blocks: [{ type: 'text', text: `body${index}` }],
    timestamp: index,
    source: 'transcript',
    ...(index % 4 === seed % 4 ? { queued: true } : {}),
    ...(index % 5 === seed % 5 ? { unsent: true } : {}),
    ...(index % 10 === 0 ? { journalPosition: { sequence: index, index: 0 } } : {})
  }))
}
function slotsFor(count: number, seed = 0, withSubagents = true): NativeChatTranscriptSlot[] {
  const rows = messages(count, seed)
  if (withSubagents) {
    rows.splice(
      Math.min(count, 3),
      0,
      {
        id: 'roster',
        role: 'system',
        source: 'transcript',
        timestamp: 2,
        blocks: [
          {
            type: 'subagent-group',
            groupId: 'group',
            agents: [
              { id: 'child-1', label: 'child one', state: 'working' },
              { id: 'child-2', label: 'child two', state: 'working' }
            ]
          }
        ]
      },
      {
        id: 'child-message',
        role: 'assistant',
        source: 'transcript',
        timestamp: 2.5,
        agentId: 'child-1',
        producerKind: 'agent',
        blocks: [{ type: 'text', text: 'child reply' }]
      },
      {
        id: 'orphan-message',
        role: 'assistant',
        source: 'transcript',
        timestamp: 2.6,
        agentId: 'orphan',
        producerKind: 'agent',
        blocks: [{ type: 'text', text: 'unrostered child' }]
      }
    )
  }
  const projected = projectNativeChatTranscript(rows)
  const membership = nativeChatTurnMembership(projected.conversation)
  const slots = buildNativeChatTranscriptSlots({
    messages: nativeChatRowsInDrawOrder(projected.conversation, membership.drawOrder),
    turnKeys: nativeChatRowsInDrawOrder(membership.turnKeys, membership.drawOrder),
    liveTurnKey: membership.liveTurnKey,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: true,
    lifecycleWorking: false,
    subagentSections: nativeChatSubagentSections(projected.conversation, projected.subagentRows),
    subagentChoices: {
      sections: new Map([
        ['child-1', true],
        ['orphan', true]
      ]),
      rosters: new Map([['roster', true]])
    }
  })
  for (const slot of slots) {
    if (slot.kind === 'message') {
      Object.freeze(slot.message)
    }
    Object.freeze(slot)
  }
  return slots
}
function expected(slots: readonly NativeChatTranscriptSlot[], phase: Phase) {
  const command = phase === 'command' || phase === 'legacy-command'
  const queuedIds = new Set(
    slots.flatMap((slot) =>
      slot.kind === 'message' && slot.message.queued === true ? [slot.message.id] : []
    )
  )
  const waiting = (slot: NativeChatTranscriptSlot) =>
    slot.kind === 'message' &&
    ((command && queuedIds.has(slot.message.id)) ||
      (slot.message.unsent === true && slot.message.journalPosition === undefined))
  return { slots: slots.filter((slot) => !waiting(slot)), waitingSlots: slots.filter(waiting) }
}
function counted(
  slots: readonly NativeChatTranscriptSlot[],
  items: readonly AgentJournalRenderItem[] | undefined
) {
  const ids = new Set(slots.flatMap((slot) => (slot.kind === 'message' ? [slot.message.id] : [])))
  const original = Set.prototype.has
  let reads = 0
  const spy = vi.spyOn(Set.prototype, 'has').mockImplementation(function (
    this: Set<unknown>,
    value: unknown
  ) {
    if (original.call(ids, value)) {
      reads += 1
    }
    return original.call(this, value)
  })
  try {
    return { result: splitNativeChatSlotsWaitingBehindLiveTurn(slots, items), reads }
  } finally {
    spy.mockRestore()
  }
}
function sameRefs(
  actual: ReturnType<typeof splitNativeChatSlotsWaitingBehindLiveTurn>,
  wanted: ReturnType<typeof splitNativeChatSlotsWaitingBehindLiveTurn>
): void {
  expect(actual).toEqual(wanted)
  for (const key of ['slots', 'waitingSlots'] as const) {
    expect(actual[key]).not.toBe(wanted[key])
    actual[key].forEach((slot, index) => expect(slot).toBe(wanted[key][index]))
  }
}

const PHASES: readonly Phase[] = [
  'none',
  'command',
  'settled',
  'request',
  'legacy-command',
  'missing-command',
  'newer-completed'
]

describe('native-chat waiting partition classification budget', () => {
  it.each([1, 12, 128, 1000])(
    'classifies each message once in an actual %i-row transcript',
    (count) => {
      const slots = Object.freeze(slotsFor(count))
      const before = [...slots]
      const measurements: number[] = []
      for (const phase of PHASES) {
        const items = journal(phase)
        const itemsBefore = structuredClone(items)
        const measured = counted(slots, items)
        sameRefs(measured.result, expected(slots, phase))
        sameRefs(measured.result, splitNativeChatSlotsWaitingBehindLiveTurn(slots, items))
        expect(slots).toEqual(before)
        expect(items).toEqual(itemsBefore)
        measurements.push(measured.reads)
      }
      expect(slots.map((slot) => slot.kind)).toContain('subagent-entries')
      expect(slots.map((slot) => slot.kind)).toContain('subagent')
      const messageCount = slots.filter((slot) => slot.kind === 'message').length
      expect(measurements).toEqual(PHASES.map(() => messageCount))
    }
  )

  it('preserves duplicate slot references, sparse admission and later journal replacements', () => {
    for (let seed = 0; seed < 128; seed += 1) {
      const slots = slotsFor(seed % 31, seed)
      if (slots.length && seed % 2) {
        slots.splice(1, 0, slots[0]!)
      }
      if (slots.length > 3 && seed % 3 === 0) {
        delete slots[2]
      }
      const before = slots.slice()
      Object.freeze(slots)
      for (const phase of PHASES) {
        const result = splitNativeChatSlotsWaitingBehindLiveTurn(slots, journal(phase))
        sameRefs(result, expected(slots, phase))
        sameRefs(result, splitNativeChatSlotsWaitingBehindLiveTurn(slots, journal(phase)))
        expect(slots).toEqual(before)
      }
    }
  })

  it('keeps empty and unusual IDs as ordinary values and returns fresh empty arrays', () => {
    sameRefs(splitNativeChatSlotsWaitingBehindLiveTurn([], undefined), {
      slots: [],
      waitingSlots: []
    })
    const slots = slotsFor(12, 7).map((slot, index) =>
      slot.kind === 'message'
        ? {
            ...slot,
            message: {
              ...slot.message,
              id: ['', 'same', 'same', '__proto__', 'constructor', '東京', 'i\u0307', '💡'][
                index % 8
              ]!
            }
          }
        : slot
    )
    for (const phase of PHASES) {
      sameRefs(
        splitNativeChatSlotsWaitingBehindLiveTurn(slots, journal(phase)),
        expected(slots, phase)
      )
    }
    sameRefs(splitNativeChatSlotsWaitingBehindLiveTurn(slots, []), expected(slots, 'none'))
  })

  it('preserves single-row ordinary, queued and held-unsent placement in each journal state', () => {
    for (const seed of [0, 1]) {
      for (const count of [1, 12]) {
        const slots = Object.freeze(slotsFor(count, seed, false))
        for (const phase of PHASES) {
          sameRefs(
            splitNativeChatSlotsWaitingBehindLiveTurn(slots, journal(phase)),
            expected(slots, phase)
          )
        }
      }
    }
  })
})
