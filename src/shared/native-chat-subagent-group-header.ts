// One spawn group's header line — headline, verdict, alert, clock and tokens — decided once for
// every transcript that draws a roster row (desktop and the phone). Each passes its own `say`.

import { normalizeSubagentState, summarizeSubagentGroup } from './native-chat-subagent-summary'
import type { NativeChatSubagentEntry, NativeChatSubagentState } from './native-chat-types'

export const NATIVE_CHAT_SUBAGENT_GROUP_COPY = {
  stateCompleted: 'completed',
  stateWorking: 'working',
  stateIdle: 'idle',
  stateFailed: 'failed',
  stateStopped: 'stopped',
  stateUnverifiable: 'status unavailable',
  stateWorkingCount: '{{value0}} working',
  stateIdleCount: '{{value0}} idle',
  stateFailedCount: '{{value0}} failed',
  stateStoppedCount: '{{value0}} stopped',
  stateUnverifiableCount: '{{value0}} with status unavailable',
  startedOne: 'Kicked off 1 subagent',
  startedN: 'Kicked off {{value0}} subagents',
  ranOne: 'Ran 1 subagent',
  ranN: 'Ran {{value0}} subagents',
  tokens: '{{value0}} tokens'
} as const

export type NativeChatSubagentGroupCopyId = keyof typeof NATIVE_CHAT_SUBAGENT_GROUP_COPY

export type NativeChatSubagentGroupSay = (
  id: NativeChatSubagentGroupCopyId,
  values?: { value0: string | number }
) => string

/** Any surface without translations. */
export const sayNativeChatSubagentGroupEnglish: NativeChatSubagentGroupSay = (id, values) =>
  values === undefined
    ? NATIVE_CHAT_SUBAGENT_GROUP_COPY[id]
    : NATIVE_CHAT_SUBAGENT_GROUP_COPY[id].replaceAll('{{value0}}', () => String(values.value0))

/** Compact token counts: the row shows scale, not an exact ledger. */
export function formatSubagentTokens(tokens: number): string {
  if (tokens < 1_000) {
    return String(Math.round(tokens))
  }
  const scaled = tokens < 1_000_000 ? tokens / 1_000 : tokens / 1_000_000
  const suffix = tokens < 1_000_000 ? 'k' : 'M'
  return `${scaled.toFixed(1).replace(/\.0$/, '')}${suffix}`
}

/** The group's one-line verdict. A single-child group reads as a bare word; any
 *  larger group always carries the count, because "working" alone would not say
 *  how many of the children it covers. `completed` never takes one: every child
 *  finishing is the whole group finishing. */
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
  const value = { value0: count }
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
  const headline = working
    ? summary.total === 1
      ? say('startedOne')
      : say('startedN', { value0: summary.total })
    : summary.total === 1
      ? say('ranOne')
      : say('ranN', { value0: summary.total })
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
  // A child settled with no terminal stamp — swept by the reopen, or given the
  // provider's verdict after that — stopped being observable at an unknown
  // moment. Measuring to `now` would report the time since the host died as how
  // long the child ran, on a row that is not even counting. A sibling's stamp is
  // no better: in a mixed group it would present that sibling's duration as the
  // group's while a child's run length is still unknown.
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
