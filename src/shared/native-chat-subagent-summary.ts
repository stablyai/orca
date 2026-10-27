// Share terminal-state and group summary rules with producers/desktop/mobile.
// Frozen fallback text must retain only write-time facts valid after the writer exits; live claims belong to revisable blocks.

import {
  isSubagentGroupBlock,
  type NativeChatBlock,
  type NativeChatSubagentEntry,
  type NativeChatSubagentGroupBlock,
  type NativeChatSubagentState
} from './native-chat-types'

/** Only working is in flight; producers collapse started/interacted/pending/running/paused before writing the roster. */
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

/** Report adverse outcomes before all siblings settle so failures remain visible during fan-out. */
const ADVERSE_PRECEDENCE = ['failed', 'stopped', 'unverifiable'] as const

/** A state this build does not know reads as `unverifiable`, never as working:
 *  a roster written by a newer build must not leave the row spinning forever. */
export function normalizeSubagentState(state: string): NativeChatSubagentState {
  if (state === 'working') {
    return 'working'
  }
  return TERMINAL_SUBAGENT_STATES.has(state) ? (state as NativeChatSubagentState) : 'unverifiable'
}

/** Shared durable/read bound for id, label and groupId; larger writes waste replay bytes every consumer clips anyway. */
export const MAX_SUBAGENT_FIELD_CHARS = 512

export function isTerminalSubagentState(state: string): boolean {
  return normalizeSubagentState(state) !== 'working'
}

/** Latch the child’s verdict, not lost visibility: later authoritative outcomes may replace unverifiable. */
const LATCHED_SUBAGENT_STATES: ReadonlySet<string> = new Set([
  'idle',
  'completed',
  'failed',
  'stopped'
])

/** Preserve reported outcomes. Allow unverifiable to settle when contact returns, but never return settled/lost children to working from stale progress ticks. */
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
  /** Sum latest child totals only; child counters are disjoint from the deliberately excluded parent usage. */
  tokens: number | null
  /** Synthetic elapsed-clock anchor covering latest runs: count overlaps once and omit idle gaps. Null if no run is measurable. */
  clockStartedAt: number | null
  /** Latest terminal timestamp, once the group has settled. */
  settledAt: number | null
}

export function summarizeSubagentGroup(
  agents: readonly NativeChatSubagentEntry[]
): NativeChatSubagentSummary {
  const counts = new Map<NativeChatSubagentState, number>()
  let working = 0
  let tokens: number | null = null
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
    clockStartedAt: subagentClockStart(agents, working > 0 ? null : settledAt),
    settledAt: working > 0 ? null : settledAt
  }
}

/** Every working run ends at now, so together they cover one span from the
 *  earliest of them; only settled time before that span adds to it. */
function subagentClockStart(
  agents: readonly NativeChatSubagentEntry[],
  settledAt: number | null
): number | null {
  const runs: [number, number][] = []
  let liveFrom: number | null = null
  for (const agent of agents) {
    if (typeof agent.startedAt !== 'number') {
      continue
    }
    if (normalizeSubagentState(agent.state) === 'working') {
      liveFrom = liveFrom === null ? agent.startedAt : Math.min(liveFrom, agent.startedAt)
    } else if (typeof agent.settledAt === 'number') {
      runs.push([agent.startedAt, Math.max(agent.startedAt, agent.settledAt)])
    }
  }
  const cutoff = liveFrom ?? Infinity
  let covered = 0
  let reach = -Infinity
  for (const [start, end] of runs.sort((a, b) => a[0] - b[0])) {
    covered += Math.max(0, Math.min(end, cutoff) - Math.max(start, reach))
    reach = Math.max(reach, end)
  }
  if (liveFrom !== null) {
    return liveFrom - covered
  }
  return settledAt === null || runs.length === 0 ? null : settledAt - covered
}

/** Empty rosters draw no row despite schema acceptance; counting them as renderable reserves a blank transcript gap. */
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

/** Only rendered rosters replace their frozen twin; preserve genuine adjacent prose. */
export function isReplacedSubagentGroupTwin(block: NativeChatBlock, drawsGroup: boolean): boolean {
  return drawsGroup && block.type === 'text' && isSubagentGroupFallbackText(block.text)
}

/** The row's blocks less any roster twin a drawn group replaces. */
export function withoutSubagentGroupTwins(blocks: readonly NativeChatBlock[]): NativeChatBlock[] {
  const drawsGroup = subagentGroupBlocks(blocks).length > 0
  return blocks.filter((block) => !isReplacedSubagentGroupTwin(block, drawsGroup))
}

/** Frozen fallback for clients without roster blocks: claim spawn/recorded outcomes only, never current live counts
 * (docs/reference/ssh-execution-boundary.md). Kicked off versus Ran states whether an outcome existed at write time;
 * Ran while in flight would falsely claim exit. Keep adverse counts so plain-text readers still see failures. Hosts revise structured blocks for liveness. */
export function subagentGroupFallbackText(agents: readonly NativeChatSubagentEntry[]): string {
  const { total, working, adverseState, adverseCount } = summarizeSubagentGroup(agents)
  const noun = total === 1 ? 'subagent' : 'subagents'
  const adverse = adverseState === null ? '' : ` (${adverseCount} ${adverseState})`
  return `${working > 0 ? 'Kicked off' : 'Ran'} ${total} ${noun}${adverse}`
}

/** Match frozen twin shape, not recomputed bytes: newer states normalize differently and would duplicate the roster.
 * Keep legacy — N working clauses for unreleased dev journals that replay forever; no extra false-positive surface. Sync with subagentGroupFallbackText. */
const SUBAGENT_GROUP_FALLBACK_PATTERN =
  /^(?:Kicked off \d+ subagents?(?: \u2014 \d+ working)?|Ran \d+ subagents?)(?: \(\d+ [a-z][a-z-]*\))?$/

export function isSubagentGroupFallbackText(text: string): boolean {
  return SUBAGENT_GROUP_FALLBACK_PATTERN.test(text)
}
