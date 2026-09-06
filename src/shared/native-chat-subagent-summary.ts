// One spawn group's roster → the numbers a single flat row needs.
//
// Shared because the desktop transcript and the mobile summary path must agree
// on what "N working" means, and because the producer uses the same terminal
// predicate the renderer does — a state that reads terminal here must latch
// terminal there.

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

/** A state this build does not know reads as `unverifiable`, never as working:
 *  a roster written by a newer build must not leave the row spinning forever. */
export function normalizeSubagentState(state: string): NativeChatSubagentState {
  if (state === 'working') {
    return 'working'
  }
  return TERMINAL_SUBAGENT_STATES.has(state) ? (state as NativeChatSubagentState) : 'unverifiable'
}

export function isTerminalSubagentState(state: string): boolean {
  return normalizeSubagentState(state) !== 'working'
}

export type NativeChatSubagentSummary = {
  total: number
  working: number
  /** The group's verdict once nothing is in flight; null while any child works. */
  settledState: NativeChatSubagentState | null
  /** How many children hold `settledState`. */
  settledCount: number
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
  return {
    total: agents.length,
    working,
    settledState,
    settledCount: settledState === null ? 0 : (counts.get(settledState) ?? 0),
    tokens,
    startedAt,
    settledAt: working > 0 ? null : settledAt
  }
}

export function subagentGroupBlocks(
  blocks: readonly NativeChatBlock[]
): NativeChatSubagentGroupBlock[] {
  return blocks.filter(isSubagentGroupBlock)
}
