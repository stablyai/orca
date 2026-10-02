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

type Candidate = Omit<ForkableAgentSession, 'launchConfig'>

function toCandidate(args: {
  paneKey: string
  agent: string | undefined
  providerSession: AgentProviderSessionMetadata | undefined
  title: string | undefined
  lastActiveAt: number
  live: boolean
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
    live: args.live
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
        live: true
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
        live: false
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
        live: false
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
  if (
    registry &&
    registry.identity.agentType === candidate.agent &&
    (!registry.identity.providerSession ||
      agentProviderSessionsEqual(
        candidate.agent,
        registry.identity.providerSession,
        candidate.providerSession
      ))
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
  return Array.from(byId.values(), (candidate) => ({
    ...candidate,
    launchConfig: launchConfigForCandidate(state, candidate)
  })).sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}
