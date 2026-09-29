import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  selectNativeChatActiveTurnKey,
  selectNativeChatTurnStatuses,
  type NativeChatTurnStatus
} from '../../../../shared/native-chat-turn-status'
import { selectStructuredAgentSettledTurns } from '../../../../shared/structured-agent-session-turn-timing'
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
    activeTurnKey: selectNativeChatActiveTurnKey(messages),
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
      activeTurnKey: 'u',
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

  it('puts the running turn bar under the prompt it answers', () => {
    const status: NativeChatTurnStatus = { startedAt: 1, thinking: false, workedSeconds: null }
    const slots = build([text('u', 'ask', 'user'), text('a', 'answer')], {
      activeTurnKey: 'u',
      turnStatuses: { active: status, completedByTurn: {} },
      isWorking: true
    })
    expect(slots[0]?.status).toBe(status)
    expect(slots[1]?.status).toBeUndefined()
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

describe('a send the host rejected', () => {
  const DIAGNOSTIC =
    'The provider stopped before it finished starting: claude stream-json exited (code 1): claude: not signed in.'

  // The restarted child died before starting, so the send was rejected and the exit wrote why.
  // The local clock had watched the send go pending and stop; that must not settle a turn that
  // never ran and fold the one row naming the cause behind a "Worked for 0s".
  it('leaves the row naming the cause on screen', () => {
    const messages = [
      text('orca:first-start', DIAGNOSTIC, 'system'),
      text('orca:dead', 'Reply with exactly: DEAD', 'user'),
      text('orca:restart-exit', DIAGNOSTIC, 'system')
    ]
    const settledByTurn = selectStructuredAgentSettledTurns(
      [],
      [
        {
          clientMessageId: 'dead',
          fence: 5,
          payloadFingerprint: 'fp',
          dispatchState: 'rejected',
          providerItemId: null,
          reason: 'provider_write_failed: claude: not signed in',
          submittedAt: 1,
          resolvedAt: 2
        }
      ]
    )
    const turnStatuses = selectNativeChatTurnStatuses(
      { 'orca:dead': { startedAt: 900, workedSeconds: 0 } },
      { activeTurnKey: 'orca:dead', isWorking: false, thinking: false, settledByTurn }
    )

    const slots = build(messages, { turnStatuses })

    expect(slots.map((slot) => [slot.message.id, slot.folded, slot.status])).toEqual([
      ['orca:first-start', false, undefined],
      ['orca:dead', false, undefined],
      ['orca:restart-exit', false, undefined]
    ])
  })
})

// Rows belong to the turn the host says owns them, not to the nearest preceding
// user bubble. The owned turn keys reshape the fold, the bar and liveness.
describe('turn-owned grouping', () => {
  const settled: NativeChatTurnStatus = { startedAt: 1, thinking: false, workedSeconds: 70 }
  // The #23621 shape: B lands mid-turn, three tool calls follow, one turn.
  const midTurn = [
    text('A', 'go', 'user'),
    toolRun('t1'),
    text('B', 'and also this', 'user'),
    toolRun('t2'),
    toolRun('t3'),
    toolRun('t4'),
    text('answer', 'Done.')
  ]
  const ownedKeys = midTurn.map(() => 'A')

  it("folds every row of a settled turn behind its opener's bar, across a mid-turn send", () => {
    const slots = build(midTurn, {
      turnKeys: ownedKeys,
      turnStatuses: { active: null, completedByTurn: { A: settled } }
    })
    // All four tool rows fold; the steered bubble stays visible with no bar of its own.
    expect(slots.map((slot) => [slot.message.id, slot.status ?? null])).toEqual([
      ['A', settled],
      ['B', null],
      ['answer', null]
    ])
    expect(slots[0]?.turnFolds).toBe(true)
  })

  it('returns every row of the turn when the reader opens it', () => {
    const slots = build(midTurn, {
      turnKeys: ownedKeys,
      turnStatuses: { active: null, completedByTurn: { A: settled } },
      expandedTurnKeys: new Set(['A'])
    })
    expect(slots.map((slot) => slot.message.id)).toEqual([
      'A',
      't1',
      'B',
      't2',
      't3',
      't4',
      'answer'
    ])
  })

  it("anchors a provider-opened turn's bar above its first row", () => {
    const messages = [text('u1', 'earlier', 'user'), toolRun('w1'), text('done', 'Woke up.')]
    const slots = build(messages, {
      turnKeys: ['u1', 'wake', 'wake'],
      activeTurnKey: 'wake',
      turnStatuses: { active: settled, completedByTurn: {} },
      isWorking: true
    })
    expect(slots.map((slot) => [slot.message.id, slot.status ?? null, slot.statusAbove])).toEqual([
      ['u1', null, false],
      ['w1', settled, true],
      ['done', null, false]
    ])
  })

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

  it("keeps a running turn's rows live while a newer message waits behind it", () => {
    const messages = [text('A', 'go', 'user'), toolRun('t1'), text('C', 'next up', 'user')]
    const slots = build(messages, {
      turnKeys: ['A', 'A', 'C'],
      activeTurnKey: 'A',
      isWorking: true
    })
    expect(slots.map((slot) => [slot.message.id, slot.activeTurnIsWorking])).toEqual([
      ['A', true],
      ['t1', true],
      ['C', false]
    ])
  })
})

describe("a subagent's rows speak as that subagent", () => {
  const settled: NativeChatTurnStatus = { startedAt: 1, thinking: false, workedSeconds: 5 }
  const roster: NativeChatMessage = {
    id: 'roster',
    role: 'system',
    blocks: [
      {
        type: 'subagent-group',
        groupId: 'group-1',
        agents: [{ id: 'task-1', label: 'explore the lane', state: 'working' }]
      }
    ],
    timestamp: 1,
    source: 'transcript'
  }
  const child = (id: string, body: string, agentId = 'task-1'): NativeChatMessage => ({
    ...text(id, body),
    agentId
  })
  const messages = [
    text('ask', 'summarise the repo', 'user'),
    text('answer', 'Delegated; the summary follows.'),
    roster,
    child('child-said', 'The PR is CLEAN.')
  ]

  it("keeps the parent's answer on a settled turn and folds the subagent's later words", () => {
    const slots = build(messages, {
      turnStatuses: { active: null, completedByTurn: { ask: settled } },
      subagentLabels: new Map([['task-1', 'explore the lane']])
    })
    const drawn = slots.filter((slot) => !slot.folded).map((slot) => slot.message.id)
    expect(drawn).toContain('answer')
    expect(drawn).not.toContain('child-said')
  })

  it("names the subagent on its row from the roster, and only on a subagent's row", () => {
    const slots = build(messages, {
      subagentLabels: new Map([['task-1', 'explore the lane']])
    })
    const labelOf = (id: string) => slots.find((slot) => slot.message.id === id)?.subagentLabel
    expect(labelOf('child-said')).toBe('explore the lane')
    expect(labelOf('answer')).toBeUndefined()
  })

  it("keeps the parent's run live while its subagent works below it", () => {
    const trailing = (rows: NativeChatMessage[]) =>
      build(rows)
        .filter((slot) => slot.trailingRun)
        .map((slot) => slot.message.id)
    const childRun: NativeChatMessage = { ...toolRun('child-run'), agentId: 'task-1' }
    // The parent is still inside its spawn call; the child's work does not move it past.
    expect(trailing([text('ask', 'go', 'user'), toolRun('spawn'), childRun])).toEqual([
      'spawn',
      'child-run'
    ])
    // The parent answering does move it past its own run, whatever the child does.
    expect(
      trailing([text('ask', 'go', 'user'), toolRun('spawn'), text('said', 'Done.'), childRun])
    ).toEqual(['said', 'child-run'])
  })

  it('reserves room for the caption on a subagent row', () => {
    const [parentSlot] = build([text('mine', 'same words')])
    const [childSlot] = build([child('theirs', 'same words')])
    expect(childSlot!.estimatedHeight).toBeGreaterThan(parentSlot!.estimatedHeight)
  })
})
