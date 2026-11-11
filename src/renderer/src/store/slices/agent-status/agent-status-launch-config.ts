import type { AppState } from '../../types'
import type {
  AgentStatusEntry,
  AgentType
} from '../../../../../shared/agent-status/contracts/agent-status-types'
import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig
} from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type {
  AgentLaunchConfigRegistryEntry,
  AgentLaunchConfigRegistrationMetadata
} from './agent-status-contract'
import { getLeafIdFromPaneKey, getTabIdFromPaneKey } from './agent-status-pane-key-tab-binding'
import { launchConfigsEqual } from '../../../../../shared/agent-session/lifecycle/agent-resume-record-equivalence'

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
  return invocationLaunchConfig({
    launchAttested: entry.launchAttested,
    registry: registryEntryMatchesStatus({
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
      : undefined,
    record: state.sleepingAgentSessionsByPaneKey[entry.paneKey],
    agentType: entry.agentType,
    providerSession: entry.providerSession
  })
}

/** Every reader's note for a pane's invocation: the owner's word decides; without one, the same conversation. */
export function invocationLaunchConfig(args: {
  statement?: SleepingAgentLaunchConfig | null
  launchAttested: boolean | undefined
  registry: SleepingAgentLaunchConfig | undefined
  record: AppState['sleepingAgentSessionsByPaneKey'][string] | undefined
  agentType: AgentStatusEntry['agentType']
  providerSession: AgentProviderSessionMetadata | undefined
}): SleepingAgentLaunchConfig | undefined {
  const { record, agentType, providerSession } = args
  if (args.statement !== undefined || args.launchAttested === false) {
    return args.statement ?? undefined
  }
  if (args.registry || !record?.launchConfig || record.agent !== agentType) {
    return args.registry
  }
  return args.launchAttested ||
    (!!providerSession &&
      agentProviderSessionsEqual(agentType, record.providerSession, providerSession))
    ? record.launchConfig
    : undefined
}

/** A statement (note or null) replaces the owner's word; anything else keeps the same agent's. */
export function ownerLaunchAttested(
  statement: SleepingAgentLaunchConfig | null | undefined,
  existing: AgentStatusEntry | undefined,
  agentType: AgentStatusEntry['agentType']
): boolean | undefined {
  if (statement !== undefined) {
    return statement !== null
  }
  return existing && existing.agentType === agentType ? existing.launchAttested : undefined
}

/** The owner's word turned to none: a later none (an inherited fact) must not erase a newer launch. */
export function retiresLaunch(
  existing: Pick<AgentStatusEntry, 'launchAttested'> | undefined,
  next: Pick<AgentStatusEntry, 'launchAttested'>
): boolean {
  return next.launchAttested === false && existing?.launchAttested !== false
}

type PaneNoteCopies = Partial<
  Pick<AppState, 'agentLaunchConfigByPaneKey' | 'sleepingAgentSessionsByPaneKey'>
>

/** An accepted retirement ends the pane's note: its launch registry entry and its saved record's note. */
export function retirePaneLaunchNote(state: PaneNoteCopies, paneKey: string): PaneNoteCopies {
  const patch: PaneNoteCopies = {}
  if (state.agentLaunchConfigByPaneKey?.[paneKey]) {
    const { [paneKey]: _retired, ...rest } = state.agentLaunchConfigByPaneKey
    patch.agentLaunchConfigByPaneKey = rest
  }
  const record = state.sleepingAgentSessionsByPaneKey?.[paneKey]
  if (record?.launchConfig) {
    const { launchConfig: _note, ...withoutNote } = record
    patch.sleepingAgentSessionsByPaneKey = {
      ...state.sleepingAgentSessionsByPaneKey,
      [paneKey]: withoutNote
    }
  }
  return patch
}
