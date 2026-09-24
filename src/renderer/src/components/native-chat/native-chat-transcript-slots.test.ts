import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../shared/native-chat-turn-status'
import type { NativeChatResolvedPrompt } from './native-chat-resolution-receipt'
import type { NativeChatTurnDiff } from './native-chat-turn-diffs'
import {
  buildNativeChatTranscriptSlots,
  nativeChatSlotIndexOf
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
) {
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
    latestUserIndex: messages.findLastIndex((message) => message.role === 'user'),
    currentTurnKey: undefined,
    receipts: new Map<string, NativeChatResolvedPrompt>(),
    turnStatuses: NO_STATUSES,
    turnDiffs: new Map<string, NativeChatTurnDiff>(),
    showTurnStatus: true,
    expandedTurnKeys: new Set<string>(),
    isWorking: false,
    lifecycleWorking: false,
    ...overrides
  })
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
  // The trailing run is the one still live while the turn works. Prose or a
  // further run after it settles it; a reasoning aside leaves it live.
  it('marks the last row that speaks or acts as the trailing run', () => {
    const trailing = (messages: NativeChatMessage[]) =>
      build(messages)
        .filter((slot) => slot.trailingRun)
        .map((slot) => slot.message.id)

    expect(trailing([text('u', 'go', 'user'), toolRun('a'), text('b', 'Done.')])).toEqual(['b'])
    expect(trailing([text('u', 'go', 'user'), toolRun('a'), toolRun('b')])).toEqual(['b'])
    expect(
      trailing([text('u', 'go', 'user'), toolRun('a'), text('r', 'hmm', 'reasoning')])
    ).toEqual(['a'])
    expect(trailing([toolRun('a'), text('u', 'again', 'user')])).toEqual(['a'])
  })

  // Approving a call lets that call run, and it sits in the run above the
  // receipt. A question's receipt blocks the agent on the reader, so it does not.
  it('keeps the run above an approval receipt trailing, but not above a question', () => {
    const resolution = {
      state: 'resolved' as const,
      selectedOptionId: 'yes',
      resolvedBy: 'desktop',
      resolvedAt: 1
    }
    const receipts = new Map<string, NativeChatResolvedPrompt>([
      ['approval', { kind: 'approval', title: 'Run?', detail: 'ls', options: [], resolution }],
      ['question', { kind: 'question', question: 'Which?', options: [], resolution }]
    ])
    const trailing = (receiptId: string) =>
      build([text('u', 'go', 'user'), toolRun('a'), text(receiptId, 'Run?', 'system')], {
        receipts
      })
        .filter((slot) => slot.trailingRun)
        .map((slot) => slot.message.id)

    expect(trailing('approval')).toEqual(['a'])
    expect(trailing('question')).toEqual(['question'])
  })

  // A counted row that draws nothing is a gap in the transcript: it reserves
  // estimated height for a bubble that never appears.
  it('gives no slot to a message with nothing to draw', () => {
    const slots = build([text('a', 'visible'), text('blank', ''), text('b', 'also visible')])
    expect(slots.map((slot) => slot.message.id)).toEqual(['a', 'b'])
  })

  it('keeps a message whose only content is a turn status under it', () => {
    const status: NativeChatTurnStatus = { startedAt: 1, thinking: false, workedSeconds: 4 }
    const slots = build([text('u', '', 'user')], {
      latestUserIndex: 0,
      turnStatuses: { active: status, completedByTurn: {} }
    })
    expect(slots).toHaveLength(1)
    expect(slots[0]?.status).toBe(status)
  })

  it('keeps a message whose only content is its turn diff rollup', () => {
    const diff: NativeChatTurnDiff = { files: [], added: 1, removed: 0, truncated: false }
    const slots = build([text('u', 'ask', 'user'), text('blank', '')], {
      turnDiffs: new Map([['u', diff]])
    })
    expect(slots.map((slot) => slot.message.id)).toEqual(['u', 'blank'])
    expect(slots[1]?.turnDiff).toBe(diff)
  })

  it('keeps a resolved prompt that stands in for a message drawing nothing', () => {
    const receipt = {
      kind: 'approval',
      title: 'Run it?',
      resolution: { state: 'resolved', selectedOptionId: 'yes' }
    } as unknown as NativeChatResolvedPrompt
    const slots = build([text('blank', '')], { receipts: new Map([['blank', receipt]]) })
    expect(slots).toHaveLength(1)
    expect(slots[0]?.receipt).toBe(receipt)
  })

  it('leaves the running turn status to the single transcript-tail indicator', () => {
    const status: NativeChatTurnStatus = { startedAt: 1, thinking: false, workedSeconds: null }
    const slots = build([text('u', 'ask', 'user')], {
      latestUserIndex: 0,
      turnStatuses: { active: status, completedByTurn: {} },
      isWorking: true
    })
    expect(slots[0]?.status).toBeUndefined()
  })

  it('reserves a height for every slot it keeps', () => {
    for (const slot of build([text('a', 'one'), text('b', 'two\nlines')])) {
      expect(slot.estimatedHeight).toBeGreaterThan(0)
    }
  })

  it('finds the slot a reveal names, and reports -1 for one that has no slot', () => {
    const slots = build([text('a', 'visible'), text('blank', ''), text('b', 'also visible')])
    expect(nativeChatSlotIndexOf(slots, 'b')).toBe(1)
    expect(nativeChatSlotIndexOf(slots, 'blank')).toBe(-1)
    expect(nativeChatSlotIndexOf(slots, undefined)).toBe(-1)
  })
})
