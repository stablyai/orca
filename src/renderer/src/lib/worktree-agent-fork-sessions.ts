import {
  supportsNativeAgentFork,
  type NativeForkTuiAgent
} from '../../../shared/agent-session-fork-argv'
import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type {
  AgentLaunchConfigRegistryEntry,
  RetainedAgentEntry
} from '@/store/slices/agent-status-contract'
import { registryEntryMatchesStatus } from '@/store/slices/agent-status-launch-config'
import { getTabIdFromPaneKey } from '@/store/slices/agent-status-pane-key-tab-binding'

export type ForkableAgentSession = {
  providerSessionId: string
  paneKey: string
  agent: NativeForkTuiAgent
  providerSession: AgentProviderSessionMetadata
  launchConfig: SleepingAgentLaunchConfig | null
  title: string | null
  lastActiveAt: number
  live: boolean
}

export type ForkableAgentSessionsState = {
  agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry | undefined>
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord | undefined>
  agentLaunchConfigByPaneKey: Record<string, AgentLaunchConfigRegistryEntry | undefined>
}

type Candidate = Omit<ForkableAgentSession, 'launchConfig'> & {
  /** Launch identity the registry entry must match; absent when the source row cannot prove it. */
  tabId: string | undefined
  terminalHandle: string | undefined
}

function toCandidate(args: {
  paneKey: string
  agent: string | undefined
  providerSession: AgentProviderSessionMetadata | undefined
  title: string | undefined
  lastActiveAt: number
  live: boolean
  tabId: string | undefined
  terminalHandle: string | undefined
}): Candidate | null {
  const { agent, providerSession } = args
  const id = providerSession?.id.trim()
  if (
    !agent ||
    !supportsNativeAgentFork(agent) ||
    !providerSession ||
    providerSession.key !== 'session_id' ||
    !id
  ) {
    return null
  }
  return {
    providerSessionId: id,
    paneKey: args.paneKey,
    agent,
    providerSession,
    title: args.title ?? null,
    lastActiveAt: args.lastActiveAt,
    live: args.live,
    tabId: args.tabId ?? getTabIdFromPaneKey(args.paneKey) ?? undefined,
    terminalHandle: args.terminalHandle
  }
}

function collectCandidates(state: ForkableAgentSessionsState, worktreeId: string): Candidate[] {
  const candidates: (Candidate | null)[] = []
  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    // Why: a restored-unconfirmed row may name a session the pane no longer runs.
    if (!entry || entry.worktreeId !== worktreeId || entry.restoredUnconfirmed === true) {
      continue
    }
    candidates.push(
      toCandidate({
        paneKey,
        agent: entry.agentType,
        providerSession: entry.providerSession,
        title: entry.terminalTitle,
        lastActiveAt: entry.updatedAt,
        live: true,
        tabId: entry.tabId,
        terminalHandle: entry.terminalHandle
      })
    )
  }
  for (const [paneKey, retained] of Object.entries(state.retainedAgentsByPaneKey)) {
    if (!retained || retained.worktreeId !== worktreeId) {
      continue
    }
    candidates.push(
      toCandidate({
        paneKey,
        agent: retained.agentType,
        providerSession: retained.entry.providerSession,
        title: retained.entry.terminalTitle,
        lastActiveAt: retained.entry.updatedAt,
        live: false,
        tabId: retained.entry.tabId ?? retained.tab.id,
        terminalHandle: retained.entry.terminalHandle
      })
    )
  }
  for (const [paneKey, record] of Object.entries(state.sleepingAgentSessionsByPaneKey)) {
    if (!record || record.worktreeId !== worktreeId) {
      continue
    }
    candidates.push(
      toCandidate({
        paneKey,
        agent: record.agent,
        providerSession: record.providerSession,
        title: record.terminalTitle,
        lastActiveAt: record.updatedAt,
        live: false,
        tabId: record.tabId,
        terminalHandle: undefined
      })
    )
  }
  return candidates.filter((candidate) => candidate !== null)
}

function isPreferred(candidate: Candidate, existing: Candidate | undefined): boolean {
  if (!existing) {
    return true
  }
  // Why: a live pane is the current owner of a provider session even if a stale snapshot is newer.
  if (candidate.live !== existing.live) {
    return candidate.live
  }
  return candidate.lastActiveAt > existing.lastActiveAt
}

// Why: a pane that ran Claude then Codex keeps the other agent's config; forking with it runs the wrong CLI.
function launchConfigForCandidate(
  state: ForkableAgentSessionsState,
  candidate: Candidate
): SleepingAgentLaunchConfig | null {
  const record = state.sleepingAgentSessionsByPaneKey[candidate.paneKey]
  if (
    record?.launchConfig &&
    record.agent === candidate.agent &&
    agentProviderSessionsEqual(candidate.agent, record.providerSession, candidate.providerSession)
  ) {
    return record.launchConfig
  }
  const registry = state.agentLaunchConfigByPaneKey[candidate.paneKey]
  // Why: same stale-proof rules as getLaunchConfigForEntry; an unprovable launch token or handle means
  // another launch's account env, so the fork falls back to the user's defaults.
  if (
    registry &&
    registry.identity.agentType === candidate.agent &&
    registryEntryMatchesStatus({
      entry: registry,
      paneKey: candidate.paneKey,
      agentType: candidate.agent,
      tabId: candidate.tabId,
      terminalHandle: candidate.terminalHandle,
      launchToken: undefined,
      providerSession: candidate.providerSession,
      existingProviderSession: candidate.providerSession,
      providerSessionChanged: false
    })
  ) {
    return registry.launchConfig
  }
  return null
}

export function listForkableAgentSessions(
  state: ForkableAgentSessionsState,
  worktreeId: string
): ForkableAgentSession[] {
  const byId = new Map<string, Candidate>()
  for (const candidate of collectCandidates(state, worktreeId)) {
    if (isPreferred(candidate, byId.get(candidate.providerSessionId))) {
      byId.set(candidate.providerSessionId, candidate)
    }
  }
  return Array.from(byId.values(), (candidate) => {
    const { tabId: _tabId, terminalHandle: _terminalHandle, ...session } = candidate
    return { ...session, launchConfig: launchConfigForCandidate(state, candidate) }
  }).sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}
