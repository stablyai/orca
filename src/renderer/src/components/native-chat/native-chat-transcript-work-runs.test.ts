import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatResolvedPrompt } from './native-chat-resolution-receipt'
import type { NativeChatTurnDiff } from './native-chat-turn-diffs'
import type { NativeChatTurnStatus } from '../../../../shared/native-chat-turn-status'
import {
  buildNativeChatTranscriptSlots,
  nativeChatSlotIndexOf,
  type NativeChatMessageSlot
} from './native-chat-transcript-slots'
import {
  nativeChatWorkRunEditKey,
  nativeChatWorkRunEntries
} from '../../../../shared/native-chat-work-run'

function text(id: string, body: string, role: NativeChatMessage['role'] = 'assistant') {
  return {
    id,
    role,
    blocks: [{ type: 'text' as const, text: body }],
    timestamp: 1,
    source: 'transcript' as const
  }
}

function thought(id: string): NativeChatMessage {
  return { ...text(id, `thinking ${id}`, 'reasoning'), state: 'completed', completedAt: 2 }
}

function call(id: string, name = 'shell'): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [
      { type: 'tool-call', name, input: { command: id }, state: 'completed', callId: `c-${id}` }
    ],
    timestamp: 1,
    source: 'transcript'
  }
}

/** Agent words with a call folded under them, as `foldToolMessages` hands them over. */
function lead(id: string): NativeChatMessage {
  return { ...call(id), blocks: [{ type: 'text', text: `${id} says` }, ...call(id).blocks] }
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
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map<string, NativeChatTurnDiff>(),
    expandedTurnKeys: new Set<string>(),
    isWorking: false,
    lifecycleWorking: false,
    ...overrides
  }).filter((slot): slot is NativeChatMessageSlot => slot.kind === 'message')
}

/** Each slot as its id, or its members' ids when it draws a work run. */
function rows(slots: NativeChatMessageSlot[]): (string | string[])[] {
  return slots.map((slot) => slot.workRun?.map((message) => message.id) ?? slot.message.id)
}

describe('work runs', () => {
  // A model that thinks before every call: one row, not one per thought and one per call.
  it('draws thoughts and the calls between them as one row', () => {
    const slots = build([
      text('u', 'go', 'user'),
      thought('r1'),
      call('a'),
      thought('r2'),
      call('b'),
      thought('r3'),
      lead('x'),
      thought('r4'),
      call('d'),
      text('y', 'Done.')
    ])
    expect(rows(slots)).toEqual(['u', ['r1', 'a', 'r2', 'b', 'r3'], ['x', 'r4', 'd'], 'y'])
  })

  // The words a call was folded under head the run, so their calls and the ones after a
  // thought read as one run, not two.
  it('lets the agent words that carry calls head the run, but never join one', () => {
    expect(
      rows(
        build([
          text('u', 'go', 'user'),
          lead('x'),
          thought('r1'),
          call('a'),
          lead('y'),
          thought('r2'),
          text('z', 'Done.')
        ])
      )
    ).toEqual(['u', ['x', 'r1', 'a'], ['y', 'r2'], 'z'])
  })

  it('leaves a thought with no call beside it as its own row', () => {
    expect(rows(build([text('u', 'go', 'user'), thought('r'), text('x', 'Hi.')]))).toEqual([
      'u',
      'r',
      'x'
    ])
    expect(
      rows(build([text('u', 'go', 'user'), thought('r1'), thought('r2'), text('x', 'Hi.')]))
    ).toEqual(['u', 'r1', 'r2', 'x'])
  })

  it('never joins rows from two turns', () => {
    expect(
      rows(build([text('u1', 'go', 'user'), call('a'), text('u2', 'more', 'user'), call('b')]))
    ).toEqual(['u1', 'a', 'u2', 'b'])
  })

  it('ends a run at a receipt, which keeps its own row', () => {
    const receipts = new Map<string, NativeChatResolvedPrompt>([
      [
        'approval',
        {
          kind: 'approval',
          title: 'Run?',
          detail: 'ls',
          options: [],
          resolution: {
            state: 'resolved',
            selectedOptionId: 'y',
            resolvedBy: 'desktop',
            resolvedAt: 1
          }
        }
      ]
    ])
    const slots = build(
      [
        text('u', 'go', 'user'),
        call('a'),
        call('b'),
        text('approval', 'Run?', 'system'),
        call('c')
      ],
      { receipts }
    )
    expect(rows(slots)).toEqual(['u', ['a', 'b'], 'approval', 'c'])
  })

  // The thought the live line is showing draws no row; it joins once it ends.
  it('keeps the run open across the thought the live line shows', () => {
    const messages = [text('u', 'go', 'user'), call('a'), thought('r1'), call('b'), thought('r2')]
    expect(rows(build(messages, { liveReasoningId: 'r2' }))).toEqual(['u', ['a', 'r1', 'b']])
    expect(rows(build(messages))).toEqual(['u', ['a', 'r1', 'b', 'r2']])
  })

  // At the top level the live line owns the open thought; once it lets go (a Stop in flight),
  // the thought joins at once rather than standing alone until the turn ends.
  it('folds an open thought the live line let go of straight into the run', () => {
    const open: NativeChatMessage = { ...thought('r2'), state: 'running', completedAt: undefined }
    const messages = [text('u', 'go', 'user'), call('a'), thought('r1'), call('b'), open]
    const live = { liveTurnKey: 'u', isWorking: true }
    expect(rows(build(messages, { ...live, liveReasoningId: 'r2' }))).toEqual([
      'u',
      ['a', 'r1', 'b']
    ])
    expect(rows(build(messages, live))).toEqual(['u', ['a', 'r1', 'b', 'r2']])
    expect(rows(build(messages))).toEqual(['u', ['a', 'r1', 'b', 'r2']])
  })

  it('is live while any of its calls is the turn frontier', () => {
    const slots = build([text('u', 'go', 'user'), call('a'), thought('r1'), call('b')], {
      liveTurnKey: 'u',
      isWorking: true
    })
    expect(slots[1]?.trailingRun).toBe(true)
  })

  // The row draws (and takes a slot), so it joins; inside the run it draws nothing.
  it('lets a thought with no visible text join rather than split the run', () => {
    const blank: NativeChatMessage = { ...thought('w'), blocks: [{ type: 'text', text: '\n' }] }
    expect(rows(build([text('u', 'go', 'user'), call('a'), blank, call('b')]))).toEqual([
      'u',
      ['a', 'w', 'b']
    ])
  })

  it('finds a member by id, for a reveal aimed at it', () => {
    const slots = build([text('u', 'go', 'user'), call('a'), thought('r1'), call('b')])
    expect(nativeChatSlotIndexOf(slots, 'b')).toBe(1)
    expect(nativeChatSlotIndexOf(slots, 'r1')).toBe(1)
  })
})

describe('work runs with an edit in their turn', () => {
  const diff: NativeChatTurnDiff = {
    files: [
      {
        path: 'a.ts',
        added: 1,
        removed: 1,
        truncated: false,
        target: { messageId: 'a', editKey: 'Diff:0', fileIndex: 0 }
      }
    ],
    added: 1,
    removed: 1,
    truncated: false
  }
  const turn = [
    text('u', 'go', 'user'),
    thought('r1'),
    call('a', 'Diff'),
    thought('r2'),
    call('b'),
    thought('r3'),
    call('c')
  ]

  // The rollup draws under the turn's newest row, which is the run's own last member while live.
  it('keeps the newest row in the live run, which carries the rollup', () => {
    const slots = build(turn, {
      liveTurnKey: 'u',
      isWorking: true,
      turnDiffs: new Map([['u', diff]])
    })
    expect(rows(slots)).toEqual(['u', ['r1', 'a', 'r2', 'b', 'r3', 'c']])
    expect(slots[1]?.trailingRun).toBe(true)
    expect(slots[1]?.turnDiff).toBe(diff)
    const thinking = build([...turn, thought('r4')], {
      liveTurnKey: 'u',
      isWorking: true,
      turnDiffs: new Map([['u', diff]])
    })
    expect(rows(thinking)).toEqual(['u', ['r1', 'a', 'r2', 'b', 'r3', 'c', 'r4']])
    expect(thinking[1]?.turnDiff).toBe(diff)
  })

  it('keeps a stopped turn that ended on work as one run once opened', () => {
    const settled: NativeChatTurnStatus = { startedAt: 1, thinking: false, workedSeconds: 4 }
    const slots = build(turn, {
      turnStatuses: { active: null, completedByTurn: { u: settled } },
      expandedTurnKeys: new Set(['u']),
      turnDiffs: new Map([['u', diff]])
    })
    expect(rows(slots)).toEqual(['u', ['r1', 'a', 'r2', 'b', 'r3', 'c']])
    expect(slots[1]?.turnDiff).toBe(diff)
    expect(slots[0]?.turnDiff).toBeUndefined()
  })
})

describe('work run height', () => {
  // Collapsed, a run draws one header: its thoughts' text reserves nothing until it opens.
  it('reserves one tool row for a collapsed run however long its thoughts are', () => {
    const long = (id: string): NativeChatMessage => ({
      ...thought(id),
      blocks: [{ type: 'text', text: 'x'.repeat(400) }]
    })
    const members = Array.from({ length: 12 }, (_, index) => [
      long(`r${index}`),
      call(`c${index}`)
    ]).flat()
    const [, lone] = build([text('u', 'go', 'user'), call('c')])
    const [, run] = build([text('u', 'go', 'user'), ...members])
    expect(run?.workRun).toHaveLength(24)
    expect(run?.estimatedHeight).toBe(lone?.estimatedHeight)
  })

  it("adds a lead head's words over the run", () => {
    const [, alone] = build([text('u', 'go', 'user'), lead('x')])
    const [, run] = build([text('u', 'go', 'user'), lead('x'), thought('r1'), call('a')])
    expect(run?.workRun).toHaveLength(3)
    expect(run?.estimatedHeight).toBe(alone?.estimatedHeight)
  })
})

describe('work run entries', () => {
  it('places each thought before the call after it, and keeps trailing ones last', () => {
    const members = [thought('r1'), call('a'), thought('r2'), call('b'), thought('r3')]
    const { blocks, thoughtsBefore, thoughtsAfter } = nativeChatWorkRunEntries(members)
    expect(blocks).toEqual([...members[1]!.blocks, ...members[3]!.blocks])
    expect(thoughtsBefore.get(blocks[0]!)?.map((m) => m.id)).toEqual(['r1'])
    expect(thoughtsBefore.get(blocks[1]!)?.map((m) => m.id)).toEqual(['r2'])
    expect(thoughtsAfter.map((m) => m.id)).toEqual(['r3'])
  })

  // The turn's diff rollup numbers an edit within its own message; the run counts across all.
  it("re-keys a message's edit to the run's numbering", () => {
    const members = [call('a', 'Diff'), call('b', 'Diff')]
    const { blocks } = nativeChatWorkRunEntries(members)
    expect(nativeChatWorkRunEditKey(members, blocks, { messageId: 'b', editKey: 'Diff:0' })).toBe(
      'Diff:1'
    )
    expect(nativeChatWorkRunEditKey(members, blocks, { messageId: 'z', editKey: 'Diff:0' })).toBe(
      null
    )
  })
})
