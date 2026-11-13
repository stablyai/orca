import { isClaudeAgent } from '../../../../../shared/agent-status/title/agent-title-identity'
import { detectAgentStatusFromTitle } from '../../../../../shared/agent-status/title/agent-title-status'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { isAgentStatusHeldOpenByChildWork } from '../../../../../shared/agent-status/lifecycle/agent-lead-status-fold'
import type { PaneForegroundAgentEntry } from '@/store/slices/agent-status/pane-foreground-agent'

/** A Claude row past its first prompt proves a request reached the provider; a session-boundary done is only a launch. */
export function hasPromptCacheRequest(
  entry: AgentStatusEntry | undefined
): entry is AgentStatusEntry {
  if (entry?.agentType !== 'claude' || entry.sessionBoundary === true) {
    return false
  }
  if (entry.state === 'done') {
    return entry.turnEndedAt !== undefined || entry.prompt !== ''
  }
  return true
}

/** Background shells or subagents hold the row working after the lead's turn ended, so its last request already went out. */
export function leadTurnEndedUnderChildWork(
  entry: Pick<AgentStatusEntry, 'state' | 'mainAgent'> | undefined
): boolean {
  return entry !== undefined && isAgentStatusHeldOpenByChildWork(entry)
}

/** When the row's last request went quiet on this renderer's clock, or null while one is in flight. */
export function promptCacheRestStartedAt(
  entry: AgentStatusEntry | undefined,
  now: number
): number | null {
  if (!hasPromptCacheRequest(entry)) {
    return null
  }
  const heldByChildWork = leadTurnEndedUnderChildWork(entry)
  if (entry.state === 'working' && !heldByChildWork) {
    return null
  }
  // Remote hosts stamp turns on their own clock; the renderer's receipt of the state change is comparable.
  const remote = entry.connectionId != null
  const turnEnd = entry.state === 'done' ? entry.turnEndedAt : undefined
  const hostRestStart = remote
    ? undefined
    : heldByChildWork
      ? entry.mainAgent?.stateStartedAt
      : turnEnd
  return Math.min(
    hostRestStart ?? entry.stateObservedAt ?? (remote ? now : entry.stateStartedAt),
    now
  )
}

/** Whether a live Claude runs the pane: true, false, or 'unread' until a process read says. */
export type LiveClaudeEvidence = boolean | 'unread'

/** Only a live process read, never a launch record that can outlive the process, settles who runs the pane. */
export function foregroundIsLiveClaude(
  foreground: PaneForegroundAgentEntry | undefined
): LiveClaudeEvidence {
  if (foreground?.shellForeground) {
    return false
  }
  return foreground?.agentEvidence === 'process-read' ? foreground.agent === 'claude' : 'unread'
}

/** A dead Claude's scrollback replays its working title too, so without a hook row a live Claude must back it. */
export function restoredTitleShowsPromptCacheRequest(
  rawTitle: string,
  entry: AgentStatusEntry | undefined,
  liveClaude: LiveClaudeEvidence
): boolean | 'await-process-read' {
  if (entry !== undefined) {
    return hasPromptCacheRequest(entry) && entry.state === 'working'
  }
  if (!isClaudeAgent(rawTitle) || detectAgentStatusFromTitle(rawTitle) !== 'working') {
    return false
  }
  return liveClaude === 'unread' ? 'await-process-read' : liveClaude
}
