// The execution host's reader of a Codex pane's parent rollout: Codex's own record of the main
// agent's turns and of its children. Every Codex event catches up on it before it is applied, and
// the rollout watch reads it on a timer while there is something left for it to settle.
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { mainAgentTurnInterrupted } from '../../agent-lead-status-fold'
import { codexRosterToSnapshots } from '../../codex-subagent-roster'
import { reconcileCodexSubagentTranscript } from '../../codex-subagent-transcript'
import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import {
  codexMainAgentStatusForPayload,
  getOrCreateCodexSubagentRoster,
  getOrCreateCodexSubagentTranscriptState,
  resolveCodexPaneStatus,
  setCodexMainAgentTurnState
} from './codex-state'

/** Catches the pane up on its parent rollout, then applies what it records to the root: a running
 *  root with no turn id adopts the rollout's latest turn if it is open or started in this read
 *  (SessionStart carries no id, nor do some Codex builds' hooks, nor a root restored from disk,
 *  whose first read starts from nothing), and a turn the rollout records ended settles. A child's
 *  hook names its own rollout, so it reads the parent a root event named earlier. */
export function catchUpOnCodexParentRollout(
  state: HookListenerState,
  paneKey: string,
  rootTranscriptPath: string | undefined
): void {
  const transcriptState = rootTranscriptPath
    ? getOrCreateCodexSubagentTranscriptState(state, paneKey)
    : state.codexSubagentTranscriptByPaneKey.get(paneKey)
  const parentPath = rootTranscriptPath ?? transcriptState?.parent.filePath
  if (!transcriptState || !parentPath) {
    return
  }
  const latestBefore = transcriptState.mainTurns.latestTurnId
  reconcileCodexSubagentTranscript(
    transcriptState,
    getOrCreateCodexSubagentRoster(state, paneKey),
    parentPath
  )
  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  const turns = transcriptState.mainTurns
  const adoptable = turns.openTurnId !== undefined || turns.latestTurnId !== latestBefore
  // Why only a root still running: a settled root with no id did not describe a later turn.
  const turnId =
    lead?.turnId ?? (lead?.state !== 'done' && adoptable ? turns.latestTurnId : undefined)
  if (!lead || turnId === undefined) {
    return
  }
  // Why: Codex records a turn's end in its rollout whether or not its Interrupt or Stop hook is
  // delivered, so this settles the turn when that hook is lost (Interrupt is capped at 3s).
  if (turnId !== lead.turnId || turns.ended.has(turnId)) {
    setCodexMainAgentTurnState(state, paneKey, {
      state: lead.state,
      ...(lead.outcome ? { outcome: lead.outcome } : {}),
      turnId,
      model: lead.model
    })
  }
}

/** The pane's Codex row, unless a drop left only its resume identity (`providerSessionOnly`):
 *  the rollout restates a row, it never brings back one that was removed. */
function liveCodexRow(
  state: HookListenerState,
  paneKey: string
): AgentHookEventPayload | undefined {
  const current = state.lastStatusByPaneKey.get(paneKey)
  return current?.payload.agentType === 'codex' && !current.providerSessionOnly
    ? current
    : undefined
}

/** Whether the rollout can still change a Codex row: a root turn open by its own record or by the
 *  rollout's, or children, each of which is read from its own rollout. */
export function codexRolloutNeedsWatch(state: HookListenerState, paneKey: string): boolean {
  const transcriptState = state.codexSubagentTranscriptByPaneKey.get(paneKey)
  if (!liveCodexRow(state, paneKey) || !transcriptState?.parent.filePath) {
    return false
  }
  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  return (
    (lead !== undefined && lead.state !== 'done') ||
    transcriptState.mainTurns.openTurnId !== undefined ||
    (state.codexSubagentRosterByPaneKey.get(paneKey)?.size ?? 0) > 0
  )
}

/** The Codex row's status rebuilt from the pane's records, or undefined when `current` already
 *  shows it. Every other field of `current` is kept. */
function codexRowFromRecords(
  state: HookListenerState,
  paneKey: string,
  current: ParsedAgentStatusPayload
): ParsedAgentStatusPayload | undefined {
  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  if (!lead) {
    return undefined
  }
  const resolution = resolveCodexPaneStatus(state, paneKey, lead)
  const payload = normalizeAgentStatusPayload({
    ...current,
    state: resolution.stateName,
    workingMode: resolution.workingMode,
    interrupted: mainAgentTurnInterrupted(lead),
    subagents: codexRosterToSnapshots(state.codexSubagentRosterByPaneKey.get(paneKey)),
    mainAgent: codexMainAgentStatusForPayload(lead)
  })
  return !payload ||
    (payload.state === current.state &&
      payload.mainAgent?.state === current.mainAgent?.state &&
      payload.mainAgent?.outcome === current.mainAgent?.outcome &&
      JSON.stringify(payload.subagents) === JSON.stringify(current.subagents))
    ? undefined
    : payload
}

/** Reads the rollout and rebuilds the pane's Codex row from the records it leaves, as an
 *  observation with no hook name or prompt: it restates the row, it is not a new turn. Returns
 *  undefined when the row's status is unchanged. */
export function observeCodexRollout(
  state: HookListenerState,
  paneKey: string
): AgentHookEventPayload | undefined {
  const current = liveCodexRow(state, paneKey)
  if (!current) {
    return undefined
  }
  catchUpOnCodexParentRollout(state, paneKey, undefined)
  const payload = codexRowFromRecords(state, paneKey, current.payload)
  if (!payload) {
    return undefined
  }
  return {
    paneKey,
    source: 'codex',
    launchToken: current.launchToken,
    tabId: current.tabId,
    worktreeId: current.worktreeId,
    connectionId: current.connectionId,
    ...(current.providerSession ? { providerSession: current.providerSession } : {}),
    // Why: a turn that only restored rows still hold open is not confirmed live by the rollout.
    ...(current.restoredUnconfirmed && payload.state !== 'done'
      ? { restoredUnconfirmed: true as const }
      : {}),
    payload
  }
}
