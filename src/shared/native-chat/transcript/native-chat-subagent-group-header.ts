// Share spawn-group headline/verdict/alert/clock/token derivation; callers supply platform translations.

import { normalizeSubagentState, summarizeSubagentGroup } from './native-chat-subagent-summary'
import type { NativeChatSubagentEntry, NativeChatSubagentState } from '../../native-chat-types'
import { englishCopyText, type CopyValues, type CountedCopy } from '../../counted-copy-english'

export const NATIVE_CHAT_SUBAGENT_GROUP_COPY = {
  stateCompleted: 'completed',
  stateWorking: 'working',
  stateIdle: 'idle',
  stateFailed: 'failed',
  stateStopped: 'stopped',
  stateUnverifiable: 'status unavailable',
  stateWorkingCount: { one: '{{count}} working', other: '{{count}} working' },
  stateIdleCount: { one: '{{count}} idle', other: '{{count}} idle' },
  stateFailedCount: { one: '{{count}} failed', other: '{{count}} failed' },
  stateStoppedCount: { one: '{{count}} stopped', other: '{{count}} stopped' },
  stateUnverifiableCount: {
    one: '{{count}} with status unavailable',
    other: '{{count}} with status unavailable'
  },
  started: { one: 'Kicked off {{count}} subagent', other: 'Kicked off {{count}} subagents' },
  ran: { one: 'Ran {{count}} subagent', other: 'Ran {{count}} subagents' },
  tokens: '{{value0}} tokens'
} as const satisfies Record<string, string | CountedCopy>

export type NativeChatSubagentGroupCopyId = keyof typeof NATIVE_CHAT_SUBAGENT_GROUP_COPY

/** Counted pieces need `count`; `tokens` takes its formatted amount as `value0`. */
export type NativeChatSubagentGroupSay = (
  id: NativeChatSubagentGroupCopyId,
  values?: CopyValues
) => string

/** Any surface without translations. */
export const sayNativeChatSubagentGroupEnglish: NativeChatSubagentGroupSay = (id, values) =>
  englishCopyText(NATIVE_CHAT_SUBAGENT_GROUP_COPY[id], values)

/** Compact token counts: the row shows scale, not an exact ledger. */
export function formatSubagentTokens(tokens: number): string {
  if (tokens < 1_000) {
    return String(Math.round(tokens))
  }
  const scaled = tokens < 1_000_000 ? tokens / 1_000 : tokens / 1_000_000
  const suffix = tokens < 1_000_000 ? 'k' : 'M'
  return `${scaled.toFixed(1).replace(/\.0$/, '')}${suffix}`
}

/** Single-child verdicts omit count; multi-child verdicts include it, except completed means the whole group finished. */
export function subagentStateLabel(
  state: NativeChatSubagentState,
  count: number,
  groupTotal: number,
  say: NativeChatSubagentGroupSay
): string {
  if (state === 'completed') {
    return say('stateCompleted')
  }
  if (groupTotal <= 1) {
    switch (state) {
      case 'working':
        return say('stateWorking')
      case 'idle':
        return say('stateIdle')
      case 'failed':
        return say('stateFailed')
      case 'stopped':
        return say('stateStopped')
      case 'unverifiable':
        return say('stateUnverifiable')
    }
  }
  const value = { count }
  switch (state) {
    case 'working':
      return say('stateWorkingCount', value)
    case 'idle':
      return say('stateIdleCount', value)
    case 'failed':
      return say('stateFailedCount', value)
    case 'stopped':
      return say('stateStoppedCount', value)
    case 'unverifiable':
      return say('stateUnverifiableCount', value)
  }
}

export type NativeChatSubagentGroupHeader = {
  total: number
  working: boolean
  /** "Kicked off 2 subagents" while any child works, else "Ran 2 subagents". */
  headline: string
  verdictState: NativeChatSubagentState
  verdict: string
  /** An adverse outcome already recorded while siblings still work; null otherwise. */
  alertState: NativeChatSubagentState | null
  alert: string | null
  /** Where the elapsed clock starts; null when the run length is unknown. */
  clockStartedAt: number | null
  settledAt: number | null
  /** "12k tokens", or null when no child reported any. */
  tokens: string | null
}

export function nativeChatSubagentGroupHeader(
  agents: readonly NativeChatSubagentEntry[],
  say: NativeChatSubagentGroupSay
): NativeChatSubagentGroupHeader {
  const summary = summarizeSubagentGroup(agents)
  const working = summary.working > 0
  const headline = say(working ? 'started' : 'ran', { count: summary.total })
  const verdictState: NativeChatSubagentState = working
    ? 'working'
    : (summary.settledState ?? 'idle')
  const verdict = working
    ? subagentStateLabel('working', summary.working, summary.total, say)
    : subagentStateLabel(verdictState, summary.settledCount, summary.total, say)
  // A child that already failed must not wait for its siblings to be readable.
  const alertState = working ? summary.adverseState : null
  const alert =
    alertState === null
      ? null
      : subagentStateLabel(alertState, summary.adverseCount, summary.total, say)
  // Any settled child without a terminal timestamp makes group duration unknown. Measuring to now includes host downtime;
  // a sibling’s timestamp would substitute its duration for an unobserved child’s run.
  const runLengthUnknown = agents.some(
    (agent) =>
      normalizeSubagentState(agent.state) !== 'working' && typeof agent.settledAt !== 'number'
  )
  const clockStartedAt =
    !runLengthUnknown && (working || summary.settledAt !== null) ? summary.clockStartedAt : null
  return {
    total: summary.total,
    working,
    headline,
    verdictState,
    verdict,
    alertState,
    alert,
    clockStartedAt,
    settledAt: summary.settledAt,
    tokens:
      summary.tokens !== null
        ? say('tokens', { value0: formatSubagentTokens(summary.tokens) })
        : null
  }
}
