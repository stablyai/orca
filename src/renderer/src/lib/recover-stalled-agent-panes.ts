/**
 * Continues every agent stalled by a login or network failure, from one plan.
 *
 * Sends through active-agent-note-send, which already routes to the worktree's
 * owner host, waits for the TUI to be idle and refuses a pane the runtime does
 * not report as a live agent — so there is no local/SSH/remote branching here.
 *
 * Only ever re-prompts a LIVE agent: the CLIs print an auth/network error and
 * return to their prompt, so a pane whose agent actually exited is a different
 * failure, covered by the pane's own cold restore.
 */

import { useAppStore } from '@/store'
import {
  planAgentStallRecovery,
  type AgentStallRecoveryStep
} from '../../../shared/agent-stall-recovery-policy'
import type { AgentStallCause } from '../../../shared/agent-stall-signature'
import { isTerminalLeafId, parsePaneKey } from '../../../shared/stable-pane-id'
import { collectStalledAgentPaneFacts } from '@/lib/stalled-agent-pane-facts'
import {
  sendNotesToActiveAgentSession,
  type ActiveAgentNotesSendStatus
} from '@/lib/active-agent-note-send'

/**
 * Asks the agent to re-verify, because the stalled turn may have half-applied its
 * work and the agent cannot see that Orca restarted it.
 *
 * Names no failure on purpose: the pane echoes Orca's paste back as PTY output,
 * so vocabulary from agent-stall-signature.ts makes the classifier re-detect
 * Orca's own prompt as a fresh stall. A ratchet test enforces this.
 */
export function buildStalledAgentContinuePrompt(cause: AgentStallCause): string {
  const hint =
    cause === 'auth'
      ? 'Your sign-in was refreshed in the meantime.'
      : cause === 'rate-limit'
        ? 'Your provider is accepting requests again.'
        : 'The link to your provider is available again.'
  return [
    'Your previous turn stopped early through no fault of your own.',
    hint,
    'Re-check which steps actually completed, then continue the task from there.',
    'Do not repeat work that already landed.'
  ].join(' ')
}

export type AgentStallRecoveryOutcomeStatus = 'continued' | 'unavailable' | 'failed'

export type AgentStallRecoveryOutcome = {
  paneKey: string
  worktreeId: string
  cause: AgentStallCause
  status: AgentStallRecoveryOutcomeStatus
  /** The underlying send status, for diagnostics. */
  sendStatus?: ActiveAgentNotesSendStatus
}

function toOutcomeStatus(sendStatus: ActiveAgentNotesSendStatus): AgentStallRecoveryOutcomeStatus {
  if (sendStatus === 'sent') {
    return 'continued'
  }
  // Why 'unavailable' and not 'failed': the pane went away or is no longer an
  // agent session, which is a state change, not a recovery error.
  return sendStatus === 'no-active-terminal' || sendStatus === 'no-agent' ? 'unavailable' : 'failed'
}

async function runRecoveryStep(step: AgentStallRecoveryStep): Promise<AgentStallRecoveryOutcome> {
  const parsed = parsePaneKey(step.paneKey)
  if (!parsed || !isTerminalLeafId(parsed.leafId)) {
    return { ...step, status: 'unavailable' }
  }
  const result = await sendNotesToActiveAgentSession({
    worktreeId: step.worktreeId,
    prompt: buildStalledAgentContinuePrompt(step.cause),
    noteTarget: { tabId: parsed.tabId, leafId: parsed.leafId }
  })
  return { ...step, status: toOutcomeStatus(result.status), sendStatus: result.status }
}

export type RecoverStalledAgentPanesOptions = {
  now?: number
  /** An explicit user request: recover now, past the settle and backoff fences. */
  force?: boolean
  /** Continue only these panes. Omitted means the whole fleet. */
  paneKeys?: readonly string[]
  /** Continue only panes stalled for these reasons — a provider coming back
   *  says nothing about the panes waiting on a different failure. */
  causes?: readonly AgentStallCause[]
}

/** Steps run one at a time: each waits for its TUI to be idle, and a parallel
 *  burst would put every pane's readiness probe on one host at once. */
export async function recoverStalledAgentPanes(
  options: RecoverStalledAgentPanesOptions = {}
): Promise<AgentStallRecoveryOutcome[]> {
  const now = options.now ?? Date.now()
  const state = useAppStore.getState()
  const paneKeyFilter = options.paneKeys ? new Set(options.paneKeys) : null
  const causeFilter = options.causes ? new Set(options.causes) : null
  const observations = Object.values(state.agentStallByPaneKey).filter(
    (observation) =>
      (!paneKeyFilter || paneKeyFilter.has(observation.paneKey)) &&
      (!causeFilter || causeFilter.has(observation.cause))
  )
  if (observations.length === 0) {
    return []
  }
  const paneFacts = collectStalledAgentPaneFacts(
    state,
    observations.map((observation) => observation.paneKey),
    now
  )
  const plan = planAgentStallRecovery({
    observations,
    paneFacts,
    ledger: state.agentStallRecoveryLedgerByPaneKey,
    now,
    ...(options.force ? { force: true } : {})
  })

  // Why here: an observation whose pane no longer exists (or aged out) would
  // otherwise keep the pane counted as stalled until the cap or TTL evicted it.
  const forgettable = plan.skipped
    .filter((skip) => skip.reason === 'unknown-pane' || skip.reason === 'expired')
    .map((skip) => skip.paneKey)
  if (forgettable.length > 0) {
    useAppStore.getState().clearAgentStallObservations(forgettable)
  }

  const outcomes: AgentStallRecoveryOutcome[] = []
  for (const step of plan.steps) {
    const observation = state.agentStallByPaneKey[step.paneKey]
    // Why record before acting: a send that throws or a renderer reload mid-walk
    // must still cost an attempt, or the backoff fence cannot hold.
    useAppStore.getState().recordAgentStallRecoveryAttempt(step.paneKey, {
      cause: step.cause,
      observedAt: observation?.observedAt ?? now,
      attemptedAt: now
    })
    let outcome: AgentStallRecoveryOutcome
    try {
      outcome = await runRecoveryStep(step)
    } catch (error) {
      console.warn(`[agent-stall] recovery failed for ${step.paneKey}:`, error)
      outcome = { ...step, status: 'failed' }
    }
    outcomes.push(outcome)
    if (outcome.status === 'continued') {
      // The ledger is kept deliberately: an agent that re-stalls immediately
      // must keep spending its attempt budget instead of looping.
      useAppStore.getState().clearAgentStallObservations([step.paneKey])
    }
  }
  return outcomes
}
