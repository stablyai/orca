// One spawn group's roster → the numbers a single flat row needs.
//
// Shared because the producer and the desktop transcript must agree on what
// "N working" means: the producer uses the same terminal predicate the renderer
// does, so a state that reads terminal here latches terminal there. Mobile has
// no roster renderer — it shows only the write-time-frozen fallback sentence,
// which is why that sentence is built from this same summary, and why the
// sentence itself may claim nothing that a later reader cannot still verify.

import {
  isSubagentGroupBlock,
  type NativeChatBlock,
  type NativeChatSubagentEntry,
  type NativeChatSubagentGroupBlock,
  type NativeChatSubagentState
} from './native-chat-types'

/** Every state a child cannot leave. `working` is the only in-flight state:
 *  providers report several (started/interacted, pending/running/paused) and the
 *  producer collapses them before the roster is written. */
const TERMINAL_SUBAGENT_STATES: ReadonlySet<string> = new Set([
  'idle',
  'completed',
  'failed',
  'stopped',
  'unverifiable'
])

/** Settled-state precedence for the group's one-line verdict: the worst
 *  outcome wins, and `completed` only shows when nothing else is left. */
const SETTLED_PRECEDENCE = ['failed', 'stopped', 'unverifiable', 'idle', 'completed'] as const

/** Outcomes that must be visible immediately, not held back until the last
 *  sibling stops working: a fan-out with a dead child is not a neutral row. */
const ADVERSE_PRECEDENCE = ['failed', 'stopped', 'unverifiable'] as const

/** A state this build does not know reads as `unverifiable`, never as working:
 *  a roster written by a newer build must not leave the row spinning forever. */
export function normalizeSubagentState(state: string): NativeChatSubagentState {
  if (state === 'working') {
    return 'working'
  }
  return TERMINAL_SUBAGENT_STATES.has(state) ? (state as NativeChatSubagentState) : 'unverifiable'
}

/** Bound on the per-child provider strings a roster row carries — `id` and
 *  `label`. One constant because the producer writes a durable row and both
 *  readers clip it again: a larger producer bound is bytes every consumer throws
 *  away, replayed on every reconnect.
 *
 *  `groupId` is deliberately NOT bounded by the producer: the row's durable
 *  identity is `codex-subagents:${groupId}` and cannot be clipped without
 *  changing which row a replay finds, so bounding only the block field would
 *  save nothing and make the two disagree. Both readers still clip it. */
export const MAX_SUBAGENT_FIELD_CHARS = 512

export function isTerminalSubagentState(state: string): boolean {
  return normalizeSubagentState(state) !== 'working'
}

/** The child's own verdict about itself. `unverifiable` is deliberately absent:
 *  it records that we stopped being able to see the child, not what it did, so
 *  a later authoritative report must still be able to correct it. */
const LATCHED_SUBAGENT_STATES: ReadonlySet<string> = new Set([
  'idle',
  'completed',
  'failed',
  'stopped'
])

/** Whether `next` may replace `current`.
 *
 *  A child that reported its own outcome keeps it. A child we merely lost sight
 *  of may still settle: the session sweep marks live children `unverifiable`,
 *  and contact can return before the row is read — latching the sweep would
 *  report a child that finished as one we never saw finish.
 *  The reverse is refused: nothing returns to `working` once we have given up on
 *  it, so a straggler progress tick cannot re-light a settled row. */
export function canReplaceSubagentState(current: string, next: string): boolean {
  const from = normalizeSubagentState(current)
  if (from === 'working') {
    return true
  }
  if (LATCHED_SUBAGENT_STATES.has(from)) {
    return false
  }
  // `from` is `unverifiable`: only a real verdict may land.
  return LATCHED_SUBAGENT_STATES.has(normalizeSubagentState(next))
}

export type NativeChatSubagentSummary = {
  total: number
  working: number
  /** The group's verdict once nothing is in flight; null while any child works. */
  settledState: NativeChatSubagentState | null
  /** How many children hold `settledState`. */
  settledCount: number
  /** Worst adverse outcome already recorded, reported even while siblings still
   *  work. Null when nothing has gone wrong. */
  adverseState: NativeChatSubagentState | null
  /** How many children hold `adverseState`. */
  adverseCount: number
  /** Sum of the latest per-child totals. Null when no child reported one.
   *  Children's counters are disjoint from the parent's, so this never
   *  double-counts — and the parent's own usage is deliberately excluded. */
  tokens: number | null
  /** Earliest child start, for the live elapsed clock. */
  startedAt: number | null
  /** Latest terminal timestamp, once the group has settled. */
  settledAt: number | null
}

export function summarizeSubagentGroup(
  agents: readonly NativeChatSubagentEntry[]
): NativeChatSubagentSummary {
  const counts = new Map<NativeChatSubagentState, number>()
  let working = 0
  let tokens: number | null = null
  let startedAt: number | null = null
  let settledAt: number | null = null
  for (const agent of agents) {
    const state = normalizeSubagentState(agent.state)
    if (state === 'working') {
      working += 1
    } else {
      counts.set(state, (counts.get(state) ?? 0) + 1)
    }
    if (typeof agent.tokens === 'number' && Number.isFinite(agent.tokens)) {
      tokens = (tokens ?? 0) + agent.tokens
    }
    if (typeof agent.startedAt === 'number') {
      startedAt = startedAt === null ? agent.startedAt : Math.min(startedAt, agent.startedAt)
    }
    if (typeof agent.settledAt === 'number') {
      settledAt = settledAt === null ? agent.settledAt : Math.max(settledAt, agent.settledAt)
    }
  }
  const settledState =
    working > 0 ? null : (SETTLED_PRECEDENCE.find((state) => counts.has(state)) ?? null)
  const adverseState = ADVERSE_PRECEDENCE.find((state) => counts.has(state)) ?? null
  return {
    total: agents.length,
    working,
    settledState,
    settledCount: settledState === null ? 0 : (counts.get(settledState) ?? 0),
    adverseState,
    adverseCount: adverseState === null ? 0 : (counts.get(adverseState) ?? 0),
    tokens,
    startedAt,
    settledAt: working > 0 ? null : settledAt
  }
}

/** A childless group draws nothing: `NativeChatSubagentRun` renders null for one,
 *  so no caller may count it as renderable. The block schema admits `agents: []`
 *  though no producer writes it, and a row that passes a renderable check while
 *  drawing nothing still costs the transcript a gap slot. */
export function isRenderableSubagentGroup(block: NativeChatSubagentGroupBlock): boolean {
  return block.agents.length > 0
}

/** The spawn groups in `blocks` that will actually draw a row. */
export function subagentGroupBlocks(
  blocks: readonly NativeChatBlock[]
): NativeChatSubagentGroupBlock[] {
  return blocks.filter(
    (block): block is NativeChatSubagentGroupBlock =>
      isSubagentGroupBlock(block) && isRenderableSubagentGroup(block)
  )
}

/** Plain-text stand-in for the roster, frozen into the journal at write time for
 *  clients without the block type.
 *
 *  It states only what stays true once the writing process is gone: the group was
 *  spawned, and whatever outcome had already latched. It deliberately carries NO
 *  live count. The row is durable and replayed on every reconnect, and the
 *  clients that read this sentence instead of the block reconcile nothing and
 *  cannot re-check the children — so a frozen `N working` would go on asserting
 *  a liveness only the dead process could have observed. That is the collapse
 *  `docs/reference/ssh-execution-boundary.md` forbids: loss of contact is not
 *  evidence of a live state. Liveness stays with the structured block, which the
 *  writing host revises in place for as long as it can see the children.
 *
 *  `Kicked off` vs `Ran` is kept, and is not a liveness claim: it reports
 *  whether an outcome had been recorded when the row was written. Saying `Ran`
 *  while children were in flight would assert they exited, which is the same
 *  error in the other direction.
 *
 *  The adverse count stays: a reader that only ever sees this sentence must not
 *  be told a failing fan-out is fine. */
export function subagentGroupFallbackText(agents: readonly NativeChatSubagentEntry[]): string {
  const { total, working, adverseState, adverseCount } = summarizeSubagentGroup(agents)
  const noun = total === 1 ? 'subagent' : 'subagents'
  const adverse = adverseState === null ? '' : ` (${adverseCount} ${adverseState})`
  return `${working > 0 ? 'Kicked off' : 'Ran'} ${total} ${noun}${adverse}`
}

/** Whether `text` is a roster block's frozen twin rather than ordinary prose.
 *  Shape-matched, not recomputed: a roster written by a newer build can hold a
 *  state this build normalizes to `unverifiable`, so its twin never equals the
 *  sentence recomputed here — and a byte compare would then print the roster
 *  twice.
 *
 *  The `— N working` clause is LEGACY. The twin carried a live count only while
 *  this feature was unreleased, so the rows holding one are dev journals of this
 *  branch rather than anything shipped — but those replay forever too, and each
 *  would print twice without this branch. It costs no false-positive surface the
 *  bare shape does not already carry, so it stays until such journals no longer
 *  matter. Keep in sync with `subagentGroupFallbackText`. */
const SUBAGENT_GROUP_FALLBACK_PATTERN =
  /^(?:Kicked off \d+ subagents?(?: — \d+ working)?|Ran \d+ subagents?)(?: \(\d+ [a-z][a-z-]*\))?$/

export function isSubagentGroupFallbackText(text: string): boolean {
  return SUBAGENT_GROUP_FALLBACK_PATTERN.test(text)
}
