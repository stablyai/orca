import type { AppState } from '../types'
import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import type {
  AgentStatusEntry,
  AgentStatusMetadata,
  AgentStatusPayload,
  AgentStatusRouting
} from './agent-status-contract'
import type { resolveAgentStatusIdentity } from '../../../../shared/agent-status-identity'
import { registryEntryMatchesStatus } from './agent-status-launch-config'
import { getTabIdFromPaneKey } from './agent-status-pane-key-tab-binding'
import { isAgentStatusTurnComplete } from '../../../../shared/agent-completion-time'

export type AgentStatusLiveEntryLaunchContext = {
  statusTabId: string | undefined
  statusTerminalHandle: string | undefined
  launchMembership: AgentStatusMetadata['launchMembership']
  registryEntry: AppState['agentLaunchConfigByPaneKey'][string] | undefined
  registryMatched: boolean
  providerSession: AgentProviderSessionMetadata | undefined
  providerSessionChanged: boolean
  retainsResumableRecoveryIdentity: boolean
  launchConfigSource: SleepingAgentLaunchConfig | undefined
}

export function deriveAgentStatusLiveEntryLaunchContext(args: {
  state: AppState
  paneKey: string
  payload: AgentStatusPayload
  existing: AgentStatusEntry | undefined
  identity: ReturnType<typeof resolveAgentStatusIdentity>
  routing?: AgentStatusRouting
  metadata?: AgentStatusMetadata
}): AgentStatusLiveEntryLaunchContext {
  const { state, paneKey, payload, existing, identity, routing, metadata } = args
  const statusTabId = routing?.tabId ?? existing?.tabId ?? getTabIdFromPaneKey(paneKey) ?? undefined
  const statusTerminalHandle = routing?.terminalHandle ?? existing?.terminalHandle
  const launchMembership =
    metadata?.launchMembership ??
    (existing?.launchMembership &&
    routing?.terminalHandle !== undefined &&
    routing.terminalHandle === existing.terminalHandle
      ? existing.launchMembership
      : undefined)
  const registryEntry = state.agentLaunchConfigByPaneKey[paneKey]
  const canReuseExistingProviderSession =
    existing?.agentType === identity.agentType &&
    (existing === undefined || !isAgentStatusTurnComplete(existing) || payload.state === 'done')
  const providerSession =
    metadata?.providerSession ??
    (canReuseExistingProviderSession ? existing.providerSession : undefined)
  const existingProviderSession = canReuseExistingProviderSession
    ? existing.providerSession
    : undefined
  const providerSessionChanged =
    Boolean(metadata?.providerSession && existingProviderSession) &&
    !agentProviderSessionsEqual(
      identity.agentType,
      metadata?.providerSession,
      existingProviderSession
    )
  const registryMatched = registryEntryMatchesStatus({
    entry: registryEntry,
    paneKey,
    agentType: identity.agentType,
    tabId: statusTabId,
    terminalHandle: statusTerminalHandle,
    launchToken: metadata?.launchToken,
    providerSession,
    existingProviderSession,
    providerSessionChanged
  })
  const matchedRegistryLaunchConfig = registryMatched ? registryEntry?.launchConfig : undefined
  const existingSleepingRecord = state.sleepingAgentSessionsByPaneKey[paneKey]
  const retainsResumableRecoveryIdentity =
    isAgentStatusTurnComplete(payload) &&
    isResumableTuiAgent(identity.agentType) &&
    providerSession !== undefined &&
    getAgentResumeArgv(identity.agentType, providerSession) !== null
  const matchedSleepingLaunchConfig =
    (!isAgentStatusTurnComplete(payload) || retainsResumableRecoveryIdentity) &&
    existingSleepingRecord?.launchConfig &&
    existingSleepingRecord.agent === identity.agentType &&
    providerSession &&
    agentProviderSessionsEqual(
      identity.agentType,
      existingSleepingRecord.providerSession,
      providerSession
    )
      ? existingSleepingRecord.launchConfig
      : undefined
  const launchConfigSource =
    (!isAgentStatusTurnComplete(payload) && !providerSessionChanged && metadata?.launchToken
      ? metadata?.launchConfig
      : undefined) ??
    matchedRegistryLaunchConfig ??
    matchedSleepingLaunchConfig
  return {
    statusTabId,
    statusTerminalHandle,
    launchMembership,
    registryEntry,
    registryMatched,
    providerSession,
    providerSessionChanged,
    retainsResumableRecoveryIdentity,
    launchConfigSource
  }
}
