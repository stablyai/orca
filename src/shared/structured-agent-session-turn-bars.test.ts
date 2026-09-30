import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from './agent-session-journal-types'
import type { NativeChatMessage } from './native-chat-types'
import { nativeChatTurnMembership } from './native-chat-turn-membership'
import {
  reduceNativeChatTurnTiming,
  selectNativeChatTurnStatuses,
  type NativeChatTurnTimingByTurn
} from './native-chat-turn-status'
import {
  selectStructuredAgentSettledTurns,
  selectStructuredAgentTurnBars,
  structuredAgentTurnLocalStartedAt,
  structuredAgentTurnOrigin
} from './structured-agent-session-turn-timing'

// Host clock of a live Claude repro (journal rows 44-79): prompt A runs a ~60 s tool
// chain; 4 s later the user sends B, which Claude picks up by interrupting A's turn.
const T = 1_790_580_000_000
const PRIOR = { requestedAt: 1_790_579_265_055, startedAt: 1_790_579_270_679 }
const PRIOR_END = 1_790_579_272_584
const A = { sent: T + 74_595, started: T + 76_146, ended: T + 92_372 }
const B = { sent: T + 79_006, started: T + 92_372, ended: T + 144_349 }
const SESSION = 'claude:55368cfb'

function user(
  sequence: number,
  clientMessageId: string,
  observedAt: number
): AgentJournalRenderItem {
  return {
    itemId: `orca:${clientMessageId}`,
    revision: 0,
    sequence,
    observedAt,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] }
  }
}

function turn(
  sequence: number,
  observedAt: number,
  record: AgentJournalTurnLifecycle
): AgentJournalRenderItem {
  return {
    itemId: `legacy:claude:55368cfb:turn-lifecycle%3A${record.turnId}`,
    revision: 1,
    sequence,
    observedAt,
    body: { kind: 'turn', ...record }
  }
}

function tool(sequence: number, observedAt: number): AgentJournalRenderItem {
  return {
    itemId: `orca:claude-tool%3A${sequence}`,
    revision: 1,
    sequence,
    observedAt,
    body: { kind: 'tool-call', name: 'Bash', input: { command: 'sleep 15' }, state: 'running' }
  }
}

function accepted(clientMessageId: string, providerItemId: string | null): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: providerItemId ? 'accepted' : 'pending',
    providerItemId,
    reason: null,
    submittedAt: 1,
    resolvedAt: providerItemId ? 2 : null
  }
}

const priorTurn = turn(47, PRIOR_END + 153, {
  turnId: '5901cefd',
  state: 'completed',
  ...PRIOR,
  completedAt: PRIOR_END,
  durationMs: 6_218,
  userItemId: `${SESSION}:5901cefd`
})
const turn1 = { turnId: '1020ab78', userItemId: `${SESSION}:1020ab78` }
const turn2 = { turnId: '6891a0bc', userItemId: `${SESSION}:6891a0bc` }
const history = [user(44, 'prior', PRIOR.requestedAt), priorTurn]
const priorSubmission = accepted('prior', `${SESSION}:5901cefd`)

/** B sent while turn 1 still runs (rows 54-61). */
const whileQueued = {
  turnId: turn1.turnId,
  items: [
    ...history,
    user(54, 'A', A.sent),
    turn(57, T + 77_224, {
      ...turn1,
      state: 'running',
      startedAt: A.started,
      requestedAt: A.sent
    }),
    tool(58, T + 77_223),
    user(60, 'B', B.sent)
  ],
  submissions: [priorSubmission, accepted('A', turn1.userItemId), accepted('B', null)]
}

/** Claude ended turn 1 to pick up B (rows 62-65). */
const turn1Ended = turn(57, A.ended + 1, {
  ...turn1,
  state: 'interrupted',
  startedAt: A.started,
  requestedAt: A.sent,
  completedAt: A.ended
})
const whileB = {
  turnId: turn2.turnId,
  items: [
    ...history,
    user(54, 'A', A.sent),
    turn1Ended,
    tool(58, T + 92_329),
    user(60, 'B', B.sent),
    turn(65, B.started, { ...turn2, state: 'running', startedAt: B.started, requestedAt: B.sent })
  ],
  submissions: [priorSubmission, accepted('A', turn1.userItemId), accepted('B', turn2.userItemId)]
}

/** Both settled (row 78). Claude's own duration for B counts from turn 1's start. */
const settled = {
  items: [
    ...whileB.items.slice(0, -1),
    turn(65, B.ended + 1, {
      ...turn2,
      state: 'completed',
      startedAt: B.started,
      requestedAt: B.sent,
      completedAt: B.ended,
      durationMs: 69_595
    })
  ],
  submissions: whileB.submissions
}

function message(id: string, role: NativeChatMessage['role'] = 'user'): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text: id }], timestamp: null, source: 'transcript' }
}

/** The row whose bar carries the running clock, as a surface places it. These journals are from a
 *  host that states no row's turn, so the bar follows the running record's named opener. */
function barOf(
  transcript: readonly NativeChatMessage[],
  snapshot: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
  }
): string | undefined {
  return nativeChatTurnMembership(transcript, snapshot).liveTurnKey
}

/** The same journal from a host that states each row's turn: a user row belongs to no turn, a
 *  steer to the turn `steers` names, and any other row to the root turn record before it. */
function scoped(
  items: readonly AgentJournalRenderItem[],
  steers: ReadonlyMap<string, string> = new Map()
): AgentJournalRenderItem[] {
  let open: string | null = null
  return items.map((item) => {
    const steered = steers.get(item.itemId)
    if (item.body.kind === 'turn') {
      open = item.itemId
    }
    const turnItemId =
      steered ??
      (item.body.kind === 'turn' || (item.body.kind === 'message' && item.body.role === 'user')
        ? null
        : open)
    return {
      ...item,
      turnScope: turnItemId ? { kind: 'turn' as const, turnItemId } : { kind: 'thread' as const }
    }
  })
}

describe('a send queued behind a running Claude turn', () => {
  it('leaves the live bar with the prompt that opened the running turn', () => {
    const bars = selectStructuredAgentTurnBars(
      whileQueued.items,
      whileQueued.submissions,
      whileQueued.turnId
    )
    const transcript = [message('orca:prior'), message('orca:A'), message('orca:B')]
    expect(barOf(transcript, whileQueued)).toBe('orca:A')
    // A was sent into an idle session: it counts from its own send, as before.
    expect(bars.runningTiming).toEqual({
      state: 'running',
      startedAt: A.started,
      requestedAt: A.sent,
      observedAt: T + 77_224
    })
    expect(bars.settledTurns.has('orca:B')).toBe(false)
  })

  it("moves the bar to B when its own turn opens, counting from A's end", () => {
    const bars = selectStructuredAgentTurnBars(whileB.items, whileB.submissions, whileB.turnId)
    const transcript = [message('orca:prior'), message('orca:A'), message('orca:B')]
    expect(barOf(transcript, whileB)).toBe('orca:B')
    expect(bars.settledTurns.get('orca:A')).toEqual({ startedAt: A.started, workedSeconds: 17 })
    expect(bars.runningTiming && structuredAgentTurnOrigin(bars.runningTiming)).toBe(A.ended)
    // A client attaching 3 s into turn 2 counts 3 s, not the 13 s B waited behind turn 1.
    expect(structuredAgentTurnLocalStartedAt(bars.runningTiming!, 50_000, B.started + 3_000)).toBe(
      47_000
    )
  })

  it('settles from the same origin the live counter used, so the bars sum to wall time', () => {
    const settledTurns = selectStructuredAgentSettledTurns(settled.items, settled.submissions)
    expect(settledTurns.get('orca:A')).toEqual({ startedAt: A.started, workedSeconds: 17 })
    // Not 65 s from B's send, and not Claude's own 69.6 s, which counts from turn 1's start.
    expect(settledTurns.get('orca:B')).toEqual({ startedAt: B.started, workedSeconds: 51 })
    // The turn before A never overlapped a send; its duration is unchanged.
    expect(settledTurns.get('orca:prior')).toEqual({ startedAt: PRIOR.startedAt, workedSeconds: 7 })

    const liveOriginB = structuredAgentTurnOrigin(
      selectStructuredAgentTurnBars(whileB.items, whileB.submissions, whileB.turnId).runningTiming!
    )
    expect(Math.floor((B.ended - liveOriginB) / 1000)).toBe(51)
    expect(A.ended - A.sent + (B.ended - liveOriginB)).toBe(B.ended - A.sent)
    expect(selectStructuredAgentTurnBars(settled.items, settled.submissions, null)).toMatchObject({
      runningTiming: null
    })
  })

  it('shows one live bar under A while B waits, then A settled and B live', () => {
    const transcript = [message('orca:A'), message('orca:tool', 'assistant'), message('orca:B')]
    const validTurnKeys = new Set(['orca:A', 'orca:B'])
    let timing: NativeChatTurnTimingByTurn = {}
    const pass = (
      snapshot: { items: AgentJournalRenderItem[]; submissions: AgentJournalSubmission[] },
      turnId: string,
      now: number
    ) => {
      const bars = selectStructuredAgentTurnBars(snapshot.items, snapshot.submissions, turnId)
      const activeTurnKey = barOf(transcript, snapshot)!
      const workingStartedAt = structuredAgentTurnLocalStartedAt(bars.runningTiming!, now, now)
      timing = reduceNativeChatTurnTiming(timing, {
        activeTurnKey,
        validTurnKeys,
        isWorking: true,
        workingStartedAt,
        now
      })
      return selectNativeChatTurnStatuses(timing, {
        activeTurnKey,
        isWorking: true,
        workingStartedAt,
        thinking: false,
        settledByTurn: bars.settledTurns
      })
    }

    const queued = pass(whileQueued, whileQueued.turnId, B.sent + 1_000)
    expect(timing['orca:A']?.startedAt).toBe(A.sent)
    expect(timing['orca:B']).toBeUndefined()
    expect(queued.completedByTurn['orca:B']).toBeUndefined()

    const running = pass(whileB, whileB.turnId, B.started + 1_000)
    expect(running.completedByTurn['orca:A']?.workedSeconds).toBe(17)
    expect(running.active?.startedAt).toBe(A.ended)
  })
})

describe('a send Codex folds into the running turn', () => {
  const key = 'codex:thread:t1:0'
  const items: AgentJournalRenderItem[] = [
    { ...user(1, 'first', 1_000) },
    {
      itemId: 'legacy:codex:s:turn-lifecycle%3At1',
      revision: 1,
      sequence: 2,
      observedAt: 1_200,
      body: {
        kind: 'turn',
        turnId: 't1',
        state: 'running',
        userItemId: key,
        requestedAt: 1_000,
        startedAt: 1_200
      }
    },
    { ...user(3, 'second', 4_000) }
  ]
  const submissions = [accepted('first', key), accepted('second', key)]
  const ended: AgentJournalRenderItem[] = [
    items[0]!,
    {
      ...items[1]!,
      observedAt: 9_000,
      body: {
        kind: 'turn',
        turnId: 't1',
        state: 'completed',
        userItemId: key,
        requestedAt: 1_000,
        startedAt: 1_200,
        completedAt: 9_000
      }
    },
    items[2]!
  ]
  const transcript = [message('orca:first'), message('orca:second')]

  it('keeps exactly one bar, under the opening prompt, live and settled', () => {
    const live = selectStructuredAgentTurnBars(items, submissions, 't1')
    expect(barOf(transcript, { items, submissions })).toBe('orca:first')
    expect(live.runningTiming && structuredAgentTurnOrigin(live.runningTiming)).toBe(1_000)

    let timing: NativeChatTurnTimingByTurn = {}
    const validTurnKeys = new Set(['orca:first', 'orca:second'])
    timing = reduceNativeChatTurnTiming(timing, {
      activeTurnKey: 'orca:first',
      validTurnKeys,
      isWorking: true,
      workingStartedAt: 1_000,
      now: 4_500
    })
    const after = selectStructuredAgentTurnBars(ended, submissions, null)
    // The turn is over: nothing names an owner, so the key falls back to the newest prompt,
    // which never ran a turn of its own and so has nothing to settle.
    const activeTurnKey = barOf(transcript, { items: ended, submissions })!
    expect(activeTurnKey).toBe('orca:second')
    timing = reduceNativeChatTurnTiming(timing, {
      activeTurnKey,
      validTurnKeys,
      isWorking: false,
      workingStartedAt: null,
      now: 9_500
    })
    const statuses = selectNativeChatTurnStatuses(timing, {
      activeTurnKey,
      isWorking: false,
      thinking: false,
      settledByTurn: after.settledTurns
    })
    expect(statuses.active).toBeNull()
    expect(Object.keys(statuses.completedByTurn)).toEqual(['orca:first'])
    expect(statuses.completedByTurn['orca:first']?.workedSeconds).toBe(8)
  })
})

describe('turns whose host names no opener', () => {
  it('falls back to the newest prompt for an older host row with no user key', () => {
    const items = [
      user(1, 'u1', 1_000),
      turn(2, 1_100, { turnId: 't1', state: 'running', startedAt: 1_100 }),
      user(3, 'u2', 2_000)
    ]
    expect(barOf([message('orca:u1'), message('orca:u2')], { items, submissions: [] })).toBe(
      'orca:u2'
    )
    // Settled timing keeps its journal-order attribution.
    expect([...selectStructuredAgentSettledTurns(items).keys()]).toEqual(['orca:u1'])
  })

  it('anchors a turn the provider opened to its own record, never a bystander prompt', () => {
    const self = 'legacy:claude:55368cfb:turn-lifecycle%3Aresumed'
    const items = [
      user(1, 'u1', 1_000),
      turn(2, 5_000, {
        turnId: 'resumed',
        state: 'running',
        startedAt: 5_000,
        userItemId: self
      })
    ]
    expect(barOf([message('orca:u1')], { items, submissions: [] })).toBe(self)
    // A host that states each row's turn anchors it the same way.
    expect(barOf([message('orca:u1')], { items: scoped(items), submissions: [] })).toBe(self)
  })

  it('keeps the running bar on the send Codex opened a turn for before it echoes it', () => {
    // Codex reports turn/started before hooks and prewarm run, so the turn names its
    // provider key while the send that opened it is still pending (no alias yet).
    const key = 'codex:thread:t2:0'
    const items: AgentJournalRenderItem[] = [
      user(1, 'first', 1_000),
      turn(2, 1_100, {
        turnId: 't1',
        state: 'completed',
        userItemId: 'orca:first',
        startedAt: 1_100,
        completedAt: 2_000
      }),
      tool(3, 1_500),
      user(4, 'second', 3_000),
      turn(5, 3_100, { turnId: 't2', state: 'running', startedAt: 3_100, userItemId: key })
    ]
    const transcript = [message('orca:first'), message('orca:second')]
    const submissions = [accepted('first', 'claude:first'), accepted('second', null)]
    for (const journal of [items, scoped(items)]) {
      const membership = nativeChatTurnMembership(transcript, { items: journal, submissions })
      expect(membership.liveTurnKey).toBe('orca:second')
      expect(membership.turnKeys[1]).toBe('orca:second')
      // A turn with no send in flight still anchors to its own record.
      const selfOpened = [accepted('first', 'claude:first'), accepted('second', 'claude:second')]
      expect(barOf(transcript, { items: journal, submissions: selfOpened })).toBe(
        'legacy:claude:55368cfb:turn-lifecycle%3At2'
      )
    }
  })

  it('names nothing for the unanchored transcript', () => {
    expect(nativeChatTurnMembership([message('a', 'assistant')], null).liveTurnKey).toBeUndefined()
  })
})

describe('the previous turn has no recorded end', () => {
  it('leaves an unverifiable turn null and a later send counting from itself', () => {
    const items = [
      user(1, 'u1', 1_000),
      turn(2, 3_000, { turnId: 't1', state: 'unverifiable', userItemId: 'orca:u1' }),
      user(3, 'u2', 10_000),
      turn(4, 12_000, {
        turnId: 't2',
        state: 'completed',
        userItemId: 'orca:u2',
        requestedAt: 10_000,
        startedAt: 11_000,
        completedAt: 20_000
      })
    ]
    const settledTurns = selectStructuredAgentSettledTurns(items)
    expect(settledTurns.get('orca:u1')).toBeNull()
    expect(settledTurns.get('orca:u2')).toEqual({ startedAt: 11_000, workedSeconds: 10 })
  })

  it("waits out the previous row's last host revision, never past its own start", () => {
    const queued = (lastSeenAt: number) =>
      selectStructuredAgentTurnBars(
        [
          user(1, 'u1', 1_000),
          turn(2, lastSeenAt, {
            turnId: 't1',
            state: 'unverifiable',
            userItemId: 'orca:u1',
            startedAt: 1_000
          }),
          user(3, 'u2', 2_000),
          turn(4, 9_000, {
            turnId: 't2',
            state: 'running',
            userItemId: 'orca:u2',
            requestedAt: 2_000,
            startedAt: 9_000
          })
        ],
        [],
        't2'
      ).runningTiming!
    expect(structuredAgentTurnOrigin(queued(6_000))).toBe(6_000)
    expect(structuredAgentTurnOrigin(queued(12_000))).toBe(9_000)
  })
})

describe('which turn owns each transcript row', () => {
  /** Each drawn row's turn, by id, as a surface places it. */
  const keysOf = (snapshot: {
    items: AgentJournalRenderItem[]
    submissions: AgentJournalSubmission[]
  }): ReadonlyMap<string, string | undefined> => {
    const transcript = snapshot.items.flatMap((item) =>
      item.body.kind === 'turn'
        ? []
        : [
            message(
              item.itemId,
              item.body.kind === 'message' && item.body.role === 'user' ? 'user' : 'tool'
            )
          ]
    )
    const { turnKeys } = nativeChatTurnMembership(transcript, snapshot)
    return new Map(transcript.map((row, index) => [row.id, turnKeys[index]]))
  }
  const turn1Record = `legacy:claude:55368cfb:turn-lifecycle%3A${turn1.turnId}`

  it('keeps the rows Claude produces after a mid-turn send with the turn that ran them', () => {
    // The #23621 shape: B lands mid-turn and three tool calls follow, one turn.
    const items = [
      user(54, 'A', A.sent),
      turn(57, T + 77_224, {
        ...turn1,
        state: 'running',
        startedAt: A.started,
        requestedAt: A.sent
      }),
      tool(58, T + 77_300),
      user(60, 'B', B.sent),
      tool(61, T + 80_100),
      tool(62, T + 80_200),
      tool(63, T + 80_300)
    ]
    const submissions = [accepted('A', turn1.userItemId), accepted('B', null)]
    const steer = new Map([['orca:B', turn1Record]])
    for (const journal of [items, scoped(items, steer)]) {
      const keys = keysOf({ items: journal, submissions })
      expect(keys.get('orca:A')).toBe('orca:A')
      expect(keys.get('orca:B')).toBe('orca:A')
      for (const sequence of [58, 61, 62, 63]) {
        expect(keys.get(`orca:claude-tool%3A${sequence}`)).toBe('orca:A')
      }
    }
  })

  it('leaves a fresh tail send in its own group until the turn proves it continued past it', () => {
    // B is the newest row: nothing after it says the running turn absorbed it.
    expect(keysOf(whileQueued).get('orca:B')).toBe('orca:B')
    // B's own turn opened: B is an opener and keys itself.
    expect(keysOf(whileB).get('orca:B')).toBe('orca:B')
    expect(keysOf(whileB).get(`orca:claude-tool%3A58`)).toBe('orca:A')
  })

  it('folds a Codex-coalesced send into the turn its provider key names', () => {
    const key = 'codex:thread:t1:0'
    const record = 'legacy:codex:s:turn-lifecycle%3At1'
    const items: AgentJournalRenderItem[] = [
      user(1, 'first', 1_000),
      {
        itemId: record,
        revision: 1,
        sequence: 2,
        observedAt: 1_200,
        body: {
          kind: 'turn',
          turnId: 't1',
          state: 'running',
          userItemId: key,
          requestedAt: 1_000,
          startedAt: 1_200
        }
      },
      user(3, 'second', 4_000),
      tool(4, 5_000)
    ]
    const submissions = [accepted('first', key), accepted('second', key)]
    for (const journal of [items, scoped(items, new Map([['orca:second', record]]))]) {
      const keys = keysOf({ items: journal, submissions })
      expect(keys.get('orca:first')).toBe('orca:first')
      expect(keys.get('orca:second')).toBe('orca:first')
      expect(keys.get('orca:claude-tool%3A4')).toBe('orca:first')
    }
  })

  it('keys a provider-opened turn and its rows to the turn record itself', () => {
    const self = 'legacy:claude:55368cfb:turn-lifecycle%3Aresumed'
    const items = [
      user(1, 'u1', 1_000),
      turn(2, 5_000, {
        turnId: 'resumed',
        state: 'running',
        startedAt: 5_000,
        userItemId: self
      }),
      tool(3, 6_000)
    ]
    for (const journal of [items, scoped(items)]) {
      const keys = keysOf({ items: journal, submissions: [] })
      // u1 predates the wake turn and never opened one: it keeps its own group.
      expect(keys.get('orca:u1')).toBe('orca:u1')
      expect(keys.get('orca:claude-tool%3A3')).toBe(self)
    }
  })

  it('groups by position for an older host that names no opener', () => {
    const items = [
      user(1, 'u1', 1_000),
      turn(2, 1_100, { turnId: 't1', state: 'running', startedAt: 1_100 }),
      tool(3, 1_200),
      user(4, 'u2', 1_300),
      tool(5, 1_400)
    ]
    expect([...keysOf({ items, submissions: [] }).values()]).toEqual([
      'orca:u1',
      'orca:u1',
      'orca:u2',
      'orca:u2'
    ])
  })
})
