import type { AppState } from '../types'
import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import type {
  AgentLaunchConfigRegistryEntry,
  AgentLaunchConfigRegistrationMetadata,
  AgentLaunchConfigStatusMetadata
} from './agent-status-contract'
import { getLeafIdFromPaneKey, getTabIdFromPaneKey } from './agent-status-pane-key-tab-binding'
import { launchConfigsEqual } from './agent-status-recovery-equivalence'

export function normalizeLaunchConfigRegistrationMetadata(
  paneKey: string,
  metadata: AgentLaunchConfigRegistrationMetadata | undefined
): AgentLaunchConfigRegistrationMetadata {
  return {
    ...(metadata?.agentType ? { agentType: metadata.agentType } : {}),
    ...(metadata?.launchToken ? { launchToken: metadata.launchToken } : {}),
    tabId: metadata?.tabId ?? getTabIdFromPaneKey(paneKey) ?? undefined,
    leafId: metadata?.leafId ?? getLeafIdFromPaneKey(paneKey) ?? undefined,
    ...(metadata?.terminalHandle ? { terminalHandle: metadata.terminalHandle } : {}),
    ...(metadata?.providerSession ? { providerSession: metadata.providerSession } : {})
  }
}

export function launchConfigRegistryEntriesEqual(
  a: AgentLaunchConfigRegistryEntry | undefined,
  b: AgentLaunchConfigRegistryEntry
): boolean {
  return (
    a !== undefined &&
    launchConfigsEqual(a.launchConfig, b.launchConfig) &&
    a.identity.agentType === b.identity.agentType &&
    a.identity.launchToken === b.identity.launchToken &&
    a.identity.tabId === b.identity.tabId &&
    a.identity.leafId === b.identity.leafId &&
    a.identity.terminalHandle === b.identity.terminalHandle &&
    agentProviderSessionsEqual(
      a.identity.agentType ?? b.identity.agentType,
      a.identity.providerSession,
      b.identity.providerSession
    )
  )
}

export function registryEntryMatchesStatus(args: {
  entry: AgentLaunchConfigRegistryEntry | undefined
  paneKey: string
  agentType: AgentType | undefined
  tabId: string | undefined
  terminalHandle: string | undefined
  launchToken: string | undefined
  providerSession: AgentProviderSessionMetadata | undefined
  existingProviderSession: AgentProviderSessionMetadata | undefined
  providerSessionChanged: boolean
}): boolean {
  const entry = args.entry
  if (!entry || args.providerSessionChanged) {
    return false
  }
  const identity = entry.identity
  if (identity.agentType !== undefined && identity.agentType !== args.agentType) {
    return false
  }
  if (identity.tabId !== undefined && identity.tabId !== args.tabId) {
    return false
  }
  if (identity.leafId !== undefined && identity.leafId !== getLeafIdFromPaneKey(args.paneKey)) {
    return false
  }
  if (
    identity.terminalHandle !== undefined &&
    (args.terminalHandle === undefined || identity.terminalHandle !== args.terminalHandle)
  ) {
    return false
  }
  if (
    identity.launchToken !== undefined &&
    (args.launchToken === undefined || identity.launchToken !== args.launchToken)
  ) {
    // Why: a missing/mismatched launch token is stale proof even if a later manual/mixed Codex run reused the provider session id.
    return false
  }
  if (identity.providerSession !== undefined) {
    return agentProviderSessionsEqual(
      args.agentType,
      identity.providerSession,
      args.providerSession
    )
  }
  if (identity.launchToken !== undefined) {
    return true
  }
  if (identity.terminalHandle !== undefined) {
    return true
  }
  if (args.existingProviderSession && args.providerSession) {
    return agentProviderSessionsEqual(
      args.agentType,
      args.existingProviderSession,
      args.providerSession
    )
  }
  return false
}

export function getLaunchConfigForEntry(
  state: AppState,
  entry: AgentStatusEntry
): SleepingAgentLaunchConfig | undefined {
  const registryEntry = state.agentLaunchConfigByPaneKey[entry.paneKey]
  const registryLaunchConfig = registryEntryMatchesStatus({
    entry: registryEntry,
    paneKey: entry.paneKey,
    agentType: entry.agentType,
    tabId: entry.tabId ?? getTabIdFromPaneKey(entry.paneKey) ?? undefined,
    terminalHandle: entry.terminalHandle,
    launchToken: undefined,
    providerSession: entry.providerSession,
    existingProviderSession: entry.providerSession,
    providerSessionChanged: false
  })
    ? registryEntry?.launchConfig
    : undefined
  if (registryLaunchConfig) {
    return registryLaunchConfig
  }
  const sleepingRecord = state.sleepingAgentSessionsByPaneKey[entry.paneKey]
  return sleepingRecord?.launchConfig &&
    sleepingRecord.agent === entry.agentType &&
    entry.providerSession &&
    agentProviderSessionsEqual(
      entry.agentType,
      sleepingRecord.providerSession,
      entry.providerSession
    )
    ? sleepingRecord.launchConfig
    : undefined
}

export function getLaunchConfigForStatusMetadata(
  state: AppState,
  metadata: AgentLaunchConfigStatusMetadata
): SleepingAgentLaunchConfig | undefined {
  const registryEntry = state.agentLaunchConfigByPaneKey[metadata.paneKey]
  return registryEntryMatchesStatus({
    entry: registryEntry,
    paneKey: metadata.paneKey,
    agentType: metadata.agentType,
    tabId: metadata.tabId ?? getTabIdFromPaneKey(metadata.paneKey) ?? undefined,
    terminalHandle: metadata.terminalHandle,
    launchToken: metadata.launchToken,
    providerSession: metadata.providerSession,
    existingProviderSession: metadata.existingProviderSession,
    providerSessionChanged: metadata.providerSessionChanged ?? false
  })
    ? registryEntry?.launchConfig
    : undefined
}
