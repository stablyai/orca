import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnScope
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { nativeChatTurnMembership } from '../../../../shared/native-chat-turn-membership'
import {
  selectNativeChatTurnStatuses,
  type NativeChatTurnStatus
} from '../../../../shared/native-chat-turn-status'
import { selectStructuredAgentSettledTurns } from '../../../../shared/structured-agent-session-turn-timing'
import type { NativeChatResolvedPrompt } from './native-chat-resolution-receipt'
import type { NativeChatTurnDiff } from './native-chat-turn-diffs'
import {
  buildNativeChatTranscriptSlots,
  nativeChatSlotIndexOf,
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
      liveTurnKey: 'u',
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
      liveTurnKey: 'u',
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

describe('a turn no message opened', () => {
  const settled = (workedSeconds: number): NativeChatTurnStatus => ({
    startedAt: 1,
    thinking: false,
    workedSeconds
  })

  it('draws its status at its first row and folds its work behind it', () => {
    const messages = [
      text('u1', 'List three fruits', 'user'),
      text('a1', 'Apple, banana, cherry.'),
      toolRun('wake-tool'),
      text('wake-answer', 'The background task finished.')
    ]
    const slots = build(messages, {
      turnKeys: ['u1', 'u1', 'wake', 'wake'],
      turnStatuses: {
        active: settled(4),
        completedByTurn: { u1: settled(4), wake: settled(9) }
      }
    })
    const statusOf = (id: string) =>
      slots.find((slot) => slot.message.id === id)?.status?.workedSeconds
    expect(statusOf('u1')).toBe(4)
    expect(statusOf('wake-tool')).toBe(9)
    expect(statusOf('wake-answer')).toBeUndefined()
    const toolSlot = slots.find((slot) => slot.message.id === 'wake-tool')
    expect(toolSlot).toMatchObject({ folded: true, turnFolds: true, turnKey: 'wake' })
  })

  const failure = (id: string): NativeChatMessage => ({
    ...text(id, 'The agent exited unexpectedly.', 'system'),
    blocks: [{ type: 'text' as const, text: 'The agent exited unexpectedly.', tone: 'error' }]
  })

  it('ends a failed turn on its error, folding the prose before it', () => {
    const messages = [
      text('u1', 'go', 'user'),
      text('a1', 'Looking.'),
      toolRun('work'),
      failure('exit')
    ]
    const slots = build(messages, {
      turnStatuses: { active: settled(3), completedByTurn: { u1: settled(3) } }
    })
    // Folded rows take no slot; the error is the turn's visible end.
    expect(slots.map((slot) => [slot.message.id, slot.folded])).toEqual([
      ['u1', false],
      ['exit', false]
    ])
  })

  it('folds an error the agent recovered from behind the answer that followed it', () => {
    const messages = [text('u1', 'go', 'user'), failure('retry'), text('a1', 'Done.')]
    const slots = build(messages, {
      turnStatuses: { active: settled(3), completedByTurn: { u1: settled(3) } }
    })
    expect(slots.map((slot) => [slot.message.id, slot.folded])).toEqual([
      ['u1', false],
      ['a1', false]
    ])
  })
})

describe('the live turn', () => {
  const settled = (workedSeconds: number): NativeChatTurnStatus => ({
    startedAt: 1,
    thinking: false,
    workedSeconds
  })
  const working: NativeChatTurnStatus = { startedAt: 1, thinking: false, workedSeconds: null }
  const THREAD: AgentJournalTurnScope = { kind: 'thread' }
  const inTurn = (turnItemId: string): AgentJournalTurnScope => ({ kind: 'turn', turnItemId })
  let sequence = 0
  const entry = (
    itemId: string,
    body: AgentJournalItemBody,
    turnScope: AgentJournalTurnScope = THREAD
  ): AgentJournalRenderItem => {
    sequence += 1
    return { itemId, revision: 0, sequence, observedAt: sequence, body, turnScope }
  }
  const record = (itemId: string, userItemId: string, state: 'running' | 'completed') =>
    entry(itemId, { kind: 'turn', turnId: itemId, state, userItemId })
  const row = (id: string, turnScope: AgentJournalTurnScope = THREAD) =>
    entry(
      id,
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: id }] },
      turnScope
    )

  /** "List three fruits", answered and settled; then a turn the provider opened on its own. */
  const messages = [
    text('u1', 'List three fruits', 'user'),
    text('a1', 'Apple, banana, cherry.'),
    toolRun('wake-tool'),
    text('wake-note', 'Checking the background build.')
  ]
  function wakeJournal(state: 'running' | 'completed'): AgentJournalRenderItem[] {
    return [
      entry('u1', { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      record('t1', 'u1', 'completed'),
      row('a1', inTurn('t1')),
      record('wake', 'claude:wake', state),
      row('wake-tool', inTurn('wake')),
      row('wake-note', inTurn('wake'))
    ]
  }
  function buildLive(
    rows: NativeChatMessage[],
    journal: AgentJournalRenderItem[] | null,
    overrides: Partial<Parameters<typeof buildNativeChatTranscriptSlots>[0]>
  ) {
    const { turnKeys, liveTurnKey } = nativeChatTurnMembership(
      rows,
      journal ? { items: journal, submissions: [] } : null
    )
    return build(rows, { turnKeys, liveTurnKey, ...overrides })
  }
  const slotOf = (slots: ReturnType<typeof build>, id: string) =>
    slots.find((slot) => slot.message.id === id)

  it('leaves the settled user turn its duration while a turn the provider opened runs', () => {
    const slots = buildLive(messages, wakeJournal('running'), {
      isWorking: true,
      turnStatuses: { active: working, completedByTurn: { u1: settled(4) } }
    })
    expect(slotOf(slots, 'u1')?.status?.workedSeconds).toBe(4)
    expect(
      slots.filter((slot) => slot.status !== undefined).map((slot) => slot.message.id)
    ).toEqual(['u1', 'wake-tool'])
  })

  it('draws a turn the provider opened at its first row, running and then settled', () => {
    const running = buildLive(messages, wakeJournal('running'), {
      isWorking: true,
      turnStatuses: { active: working, completedByTurn: { u1: settled(4) } }
    })
    expect(running.map((slot) => [slot.message.id, slot.status])).toEqual([
      ['u1', settled(4)],
      ['a1', undefined],
      ['wake-tool', working],
      ['wake-note', undefined]
    ])
    const ended = buildLive(messages, wakeJournal('completed'), {
      turnStatuses: { active: settled(4), completedByTurn: { u1: settled(4), wake: settled(9) } }
    })
    expect(slotOf(ended, 'u1')?.status?.workedSeconds).toBe(4)
    expect(slotOf(ended, 'wake-tool')?.status?.workedSeconds).toBe(9)
  })

  it('keeps the running turn live, and the settled turn before it settled', () => {
    const slots = buildLive(messages, wakeJournal('running'), { isWorking: true })
    expect(slots.map((slot) => [slot.message.id, slot.turnKey, slot.activeTurnIsWorking])).toEqual([
      ['u1', 'u1', false],
      ['a1', 'u1', false],
      ['wake-tool', 'wake', true],
      ['wake-note', 'wake', true]
    ])
  })

  it('leaves the settled user turn alone while the running turn has drawn nothing yet', () => {
    const journal = wakeJournal('running').slice(0, 4)
    const slots = buildLive(messages.slice(0, 2), journal, {
      isWorking: true,
      turnStatuses: { active: working, completedByTurn: { u1: settled(4) } }
    })
    expect(
      slots.map((slot) => [slot.message.id, slot.status?.workedSeconds, slot.activeTurnIsWorking])
    ).toEqual([
      ['u1', 4, false],
      ['a1', undefined, false]
    ])
  })

  it('still draws a running turn a message opened on that message, with its rows live', () => {
    const journal = [
      entry('u1', { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      record('t1', 'u1', 'running'),
      row('a1', inTurn('t1'))
    ]
    const rows = messages.slice(0, 2)
    const live = buildLive(rows, journal, { isWorking: true })
    expect(live.map((slot) => [slot.turnKey, slot.activeTurnIsWorking])).toEqual([
      ['u1', true],
      ['u1', true]
    ])
    const stopped = buildLive(rows, journal, {
      turnStatuses: { active: settled(3), completedByTurn: {} }
    })
    expect(slotOf(stopped, 'u1')?.status?.workedSeconds).toBe(3)
  })

  it('reads a turn the provider opened by journal order where the host states no scope', () => {
    const unscoped = wakeJournal('running').map(({ turnScope: _scope, ...rest }) => rest)
    const slots = buildLive(messages, unscoped, {
      isWorking: true,
      turnStatuses: { active: working, completedByTurn: { u1: settled(4) } }
    })
    expect(
      slots.map((slot) => [slot.turnKey, slot.status?.workedSeconds, slot.activeTurnIsWorking])
    ).toEqual([
      ['u1', 4, false],
      ['u1', undefined, false],
      ['wake', null, true],
      ['wake', undefined, true]
    ])
  })

  it('keeps the newest user row live with no journal', () => {
    const slots = buildLive(messages, null, {
      isWorking: true,
      turnStatuses: { active: settled(2), completedByTurn: {} }
    })
    expect(
      slots.map((slot) => [slot.turnKey, slot.status?.workedSeconds, slot.activeTurnIsWorking])
    ).toEqual([
      ['u1', 2, true],
      ['u1', undefined, true],
      ['u1', undefined, true],
      ['u1', undefined, true]
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
      liveTurnKey: 'wake',
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
      liveTurnKey: 'A',
      isWorking: true
    })
    expect(slots.map((slot) => [slot.message.id, slot.activeTurnIsWorking])).toEqual([
      ['A', true],
      ['t1', true],
      ['C', false]
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
