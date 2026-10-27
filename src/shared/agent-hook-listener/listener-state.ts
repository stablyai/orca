import type { HookListenerState } from './listener-state-types'
export type { HookListenerState, MusePaneState } from './listener-state-types'
export type {
  ClaudeLeadTurnState,
  CodexLeadTurnState,
  GrokActiveTurn,
  HermesPaneTurn,
  JcodeTurnAdmission
} from './main-agent-turn-state'
import {
  AGENT_STATUS_2A_CURRENT_PRODUCER_MODE,
  createAgentStatusLegacyAdapter,
  type AgentStatusLegacyAdapter,
  type AgentStatusLegacyAdapterOptions,
  type AgentStatusLegacyAdmissionMode
} from '../agent-status-legacy-adapter'
import type { AgentStatusLegacyIngressCaller } from '../agent-status-legacy-ingress-manifest'
import type { AgentHookEventPayload } from './listener-event'
import {
  deletePaneScopedCacheEntry,
  deletePaneScopedSetEntry,
  movePaneScopedMapEntries,
  movePaneScopedSetEntries
} from './pane-scoped-cache-entries'
import {
  clearJcodePaneSessions,
  createJcodeSessionRegistry,
  moveJcodePaneSessions,
  jcodePaneHasStateClaims
} from './jcode-session-registry'
import {
  moveOpenCodeSessionBindings,
  unbindOpenCodeSessionsOfPane
} from './opencode-session-registry'

const legacyStatusAdapterByState = new WeakMap<HookListenerState, AgentStatusLegacyAdapter>()

function legacyStatusAdapter(state: HookListenerState): AgentStatusLegacyAdapter {
  const adapter = legacyStatusAdapterByState.get(state)
  if (!adapter) {
    throw new Error('Hook listener state has no legacy agent-status adapter')
  }
  return adapter
}

export function createHookListenerState(
  options: AgentStatusLegacyAdapterOptions = {}
): HookListenerState {
  const adapter = createAgentStatusLegacyAdapter(options)
  const state: HookListenerState = {
    warnedVersions: new Set(),
    warnedEnvs: new Set(),
    lastPromptByPaneKey: new Map(),
    lastToolByPaneKey: new Map(),
    lastStatusByPaneKey: adapter.view,
    antigravityCompletedTranscriptByPaneKey: new Map(),
    antigravitySubagentParentByPaneKey: new Map(),
    jcodeTurnPromptByPaneKey: new Map(),
    jcodeTurnByPaneKey: new Map(),
    jcodeSessions: createJcodeSessionRegistry(),
    jcodeSubagentRosterByPaneKey: new Map(),
    jcodeRootPayloadByPaneKey: new Map(),
    jcodeTurnRevision: { current: 0 },
    ampCompletedCacheKeys: new Set(),
    claudeSubagentRosterByPaneKey: new Map(),
    claudeLeadStateByPaneKey: new Map(),
    claudeUnconfirmedRestoredStatusPaneKeys: new Set(),
    claudeRunningNonAgentTaskPaneKeys: new Set(),
    claudeActiveSessionCronPaneKeys: new Set(),
    claudeLaunchedBackgroundTasksByPaneKey: new Map(),
    claudeConsumedCompactPromptIdByPaneKey: new Map(),
    claudeSessionOwnerByPaneKey: new Map(),
    codexSubagentRosterByPaneKey: new Map(),
    codexSubagentTranscriptByPaneKey: new Map(),
    codexLeadStateByPaneKey: new Map(),
    codexEphemeralForkSessionsByPaneKey: new Map(),
    codexHeldEphemeralStartByPaneKey: new Map(),
    grokActiveTurnByPaneKey: new Map(),
    grokMainAgentStatusByPaneKey: new Map(),
    musePaneStateByPaneKey: new Map(),
    opencodeSessionPaneBySessionId: new Map(),
    lastLaunchTokenByPaneKey: new Map(),
    hermesTurnByPaneKey: new Map()
  }
  legacyStatusAdapterByState.set(state, adapter)
  return state
}

export function admitLegacyAgentStatus(
  state: HookListenerState,
  caller: AgentStatusLegacyIngressCaller,
  entry: AgentHookEventPayload,
  mode: AgentStatusLegacyAdmissionMode,
  options?: { moveToEnd?: boolean }
): boolean {
  return legacyStatusAdapter(state).admit(caller, mode, entry, options)
}

export function canAdmitLegacyAgentStatusEntry(
  state: HookListenerState,
  caller: AgentStatusLegacyIngressCaller,
  entry: AgentHookEventPayload,
  mode: AgentStatusLegacyAdmissionMode
): boolean {
  return legacyStatusAdapter(state).canAdmit(caller, mode, entry)
}

export function deleteLegacyAgentStatus(state: HookListenerState, paneKey: string): boolean {
  return legacyStatusAdapter(state).delete(paneKey)
}

export function clearLegacyAgentStatuses(state: HookListenerState): void {
  legacyStatusAdapter(state).clear()
}

export function moveLegacyAgentStatuses(
  state: HookListenerState,
  fromPaneKey: string,
  toPaneKey: string
): void {
  legacyStatusAdapter(state).move(fromPaneKey, toPaneKey)
}

export function getLegacyStatusListingOrder(
  state: HookListenerState,
  paneKey: string
): number | undefined {
  return legacyStatusAdapter(state).listingOrder(paneKey)
}

/** Test harnesses seed the same compatibility region without exposing a mutable Map. */
export function seedLegacyAgentStatusForTests(
  state: HookListenerState,
  entry: AgentHookEventPayload
): void {
  if (
    !admitLegacyAgentStatus(
      state,
      'main-status-update',
      entry,
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
    )
  ) {
    throw new Error('Test legacy agent-status seed was refused')
  }
}

export function clearPaneCacheState(state: HookListenerState, paneKey: string): void {
  clearJcodePaneSessions(state, paneKey)
  deletePaneScopedCacheEntry(state.lastPromptByPaneKey, paneKey)
  deletePaneScopedCacheEntry(state.lastToolByPaneKey, paneKey)
  deletePaneScopedCacheEntry(state.jcodeTurnPromptByPaneKey, paneKey)
  deletePaneScopedCacheEntry(state.jcodeTurnByPaneKey, paneKey)
  deletePaneScopedCacheEntry(state.jcodeSubagentRosterByPaneKey, paneKey)
  deletePaneScopedCacheEntry(state.jcodeRootPayloadByPaneKey, paneKey)
  deleteLegacyAgentStatus(state, paneKey)
  for (const key of state.lastStatusByPaneKey.keys()) {
    if (key.startsWith(`${paneKey}\0`)) {
      deleteLegacyAgentStatus(state, key)
    }
  }
  deletePaneScopedCacheEntry(state.antigravityCompletedTranscriptByPaneKey, paneKey)
  deletePaneScopedCacheEntry(state.antigravitySubagentParentByPaneKey, paneKey)
  deletePaneScopedSetEntry(state.ampCompletedCacheKeys, paneKey)
  deletePaneScopedCacheEntry(state.claudeConsumedCompactPromptIdByPaneKey, paneKey)
  state.claudeSubagentRosterByPaneKey.delete(paneKey)
  state.claudeLeadStateByPaneKey.delete(paneKey)
  state.claudeUnconfirmedRestoredStatusPaneKeys.delete(paneKey)
  state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
  state.claudeActiveSessionCronPaneKeys.delete(paneKey)
  state.claudeLaunchedBackgroundTasksByPaneKey.delete(paneKey)
  state.claudeSessionOwnerByPaneKey.delete(paneKey)
  state.codexSubagentRosterByPaneKey.delete(paneKey)
  state.codexSubagentTranscriptByPaneKey.delete(paneKey)
  state.codexLeadStateByPaneKey.delete(paneKey)
  state.codexEphemeralForkSessionsByPaneKey.delete(paneKey)
  state.codexHeldEphemeralStartByPaneKey.delete(paneKey)
  state.grokActiveTurnByPaneKey.delete(paneKey)
  state.grokMainAgentStatusByPaneKey.delete(paneKey)
  state.musePaneStateByPaneKey.delete(paneKey)
  unbindOpenCodeSessionsOfPane(state, paneKey)
  deletePaneScopedCacheEntry(state.lastLaunchTokenByPaneKey, paneKey)
  state.hermesTurnByPaneKey.delete(paneKey)
}

/** Keep claim-bearing caches aligned with clearPaneCacheState: stored rows and latches can assert state; prompt/tool/transcript caches only render it. */
export function paneHasStateClaims(state: HookListenerState, paneKey: string): boolean {
  return (
    state.lastStatusByPaneKey.has(paneKey) ||
    jcodePaneHasStateClaims(state, paneKey) ||
    state.claudeSubagentRosterByPaneKey.has(paneKey) ||
    state.claudeLeadStateByPaneKey.has(paneKey) ||
    state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) ||
    state.claudeActiveSessionCronPaneKeys.has(paneKey) ||
    state.claudeLaunchedBackgroundTasksByPaneKey.has(paneKey) ||
    state.claudeSessionOwnerByPaneKey.has(paneKey) ||
    state.codexSubagentRosterByPaneKey.has(paneKey) ||
    state.codexLeadStateByPaneKey.has(paneKey)
  )
}

export function movePaneCacheState(
  state: HookListenerState,
  fromPaneKey: string,
  toPaneKey: string
): void {
  if (fromPaneKey === toPaneKey) {
    return
  }
  if (moveJcodePaneSessions(state, fromPaneKey, toPaneKey)) {
    movePaneScopedMapEntries(state.jcodeTurnPromptByPaneKey, fromPaneKey, toPaneKey)
    movePaneScopedMapEntries(state.jcodeTurnByPaneKey, fromPaneKey, toPaneKey)
    movePaneScopedMapEntries(state.jcodeSubagentRosterByPaneKey, fromPaneKey, toPaneKey)
    movePaneScopedMapEntries(state.jcodeRootPayloadByPaneKey, fromPaneKey, toPaneKey)
  }
  movePaneScopedMapEntries(state.lastPromptByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.lastToolByPaneKey, fromPaneKey, toPaneKey)
  moveLegacyAgentStatuses(state, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.antigravityCompletedTranscriptByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.antigravitySubagentParentByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedSetEntries(state.ampCompletedCacheKeys, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeConsumedCompactPromptIdByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeSubagentRosterByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeLeadStateByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedSetEntries(state.claudeUnconfirmedRestoredStatusPaneKeys, fromPaneKey, toPaneKey)
  movePaneScopedSetEntries(state.claudeRunningNonAgentTaskPaneKeys, fromPaneKey, toPaneKey)
  movePaneScopedSetEntries(state.claudeActiveSessionCronPaneKeys, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeLaunchedBackgroundTasksByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.claudeSessionOwnerByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.codexSubagentRosterByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.codexSubagentTranscriptByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.codexLeadStateByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.codexEphemeralForkSessionsByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.codexHeldEphemeralStartByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.grokActiveTurnByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.grokMainAgentStatusByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.musePaneStateByPaneKey, fromPaneKey, toPaneKey)
  moveOpenCodeSessionBindings(state, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.lastLaunchTokenByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.hermesTurnByPaneKey, fromPaneKey, toPaneKey)
}

export function clearPaneTurnCacheState(state: HookListenerState, paneKey: string): void {
  state.lastPromptByPaneKey.delete(paneKey)
  state.lastToolByPaneKey.delete(paneKey)
  state.antigravityCompletedTranscriptByPaneKey.delete(paneKey)
  state.antigravitySubagentParentByPaneKey.delete(paneKey)
  state.jcodeTurnPromptByPaneKey.delete(paneKey)
  state.jcodeTurnByPaneKey.delete(paneKey)
  state.ampCompletedCacheKeys.delete(paneKey)
  state.grokActiveTurnByPaneKey.delete(paneKey)
  state.grokMainAgentStatusByPaneKey.delete(paneKey)
}

export function clearAllListenerCaches(state: HookListenerState): void {
  state.jcodeSessions = createJcodeSessionRegistry()
  state.lastPromptByPaneKey.clear()
  state.lastToolByPaneKey.clear()
  clearLegacyAgentStatuses(state)
  state.antigravityCompletedTranscriptByPaneKey.clear()
  state.antigravitySubagentParentByPaneKey.clear()
  state.jcodeTurnPromptByPaneKey.clear()
  state.jcodeTurnByPaneKey.clear()
  state.jcodeSubagentRosterByPaneKey.clear()
  state.jcodeRootPayloadByPaneKey.clear()
  state.ampCompletedCacheKeys.clear()
  state.claudeConsumedCompactPromptIdByPaneKey.clear()
  state.warnedVersions.clear()
  state.warnedEnvs.clear()
  state.claudeSubagentRosterByPaneKey.clear()
  state.claudeLeadStateByPaneKey.clear()
  state.claudeUnconfirmedRestoredStatusPaneKeys.clear()
  state.claudeRunningNonAgentTaskPaneKeys.clear()
  state.claudeActiveSessionCronPaneKeys.clear()
  state.claudeLaunchedBackgroundTasksByPaneKey.clear()
  state.claudeSessionOwnerByPaneKey.clear()
  state.codexSubagentRosterByPaneKey.clear()
  state.codexSubagentTranscriptByPaneKey.clear()
  state.codexLeadStateByPaneKey.clear()
  state.codexEphemeralForkSessionsByPaneKey.clear()
  state.codexHeldEphemeralStartByPaneKey.clear()
  state.grokActiveTurnByPaneKey.clear()
  state.grokMainAgentStatusByPaneKey.clear()
  state.musePaneStateByPaneKey.clear()
  state.opencodeSessionPaneBySessionId.clear()
  state.lastLaunchTokenByPaneKey.clear()
  state.hermesTurnByPaneKey.clear()
}
