import { useSyncExternalStore } from 'react'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
import type { StructuredLaunchRecoveryState } from '@/lib/structured-agent-session-launch-recovery'
import type {
  StructuredAgentLaunchOptions,
  StructuredLaunchCallerGroup
} from '@/lib/structured-agent-session-launch-callers'

export type StructuredLaunchState = StructuredLaunchRecoveryState & {
  identity: string
  /** Fixed by the caller that opened this launch; a joiner delivers its text the same way. Without
   *  that, two entrypoints racing one identity seed the composer AND submit. */
  promptDelivery: StructuredAgentLaunchOptions['promptDelivery']
  callers: StructuredLaunchCallerGroup
}

export type StructuredAgentLaunchStatus = 'idle' | 'pending' | 'unknown'

const pendingStructuredLaunchesByIdentity = new Map<string, StructuredLaunchState>()
const structuredLaunchListeners = new Set<() => void>()

export function notifyStructuredLaunchListeners(): void {
  for (const listener of structuredLaunchListeners) {
    listener()
  }
}

export function subscribeStructuredAgentLaunchStatus(listener: () => void): () => void {
  structuredLaunchListeners.add(listener)
  return () => structuredLaunchListeners.delete(listener)
}

// Why keyed by agent too: one worktree can hold a Claude and a Codex launch at once, and a shared
// key would hand the second caller the first agent's intent.
//
// Why keyed by the adopted conversation as well: a joining caller is handed the EXISTING intent and
// contributes only its prompt, so without this a resume that arrives while a blank launch is pending
// would be silently dropped — the user would get a blank chat, or another row's conversation, with
// no error. A launch that adopts a conversation is a different launch.
export function launchIdentity(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  resumeFrom?: StructuredAgentSessionResumeSource
): string {
  return resumeFrom
    ? `${agent}:${worktreeId}:resume:${resumeFrom.providerSessionId}`
    : `${agent}:${worktreeId}`
}

export function getStructuredAgentLaunchStatus(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): StructuredAgentLaunchStatus {
  // Any launch for this pair, not just the blank one: adopting launches carry the conversation in
  // their identity, and a caller asking "is a chat starting here" means all of them.
  const states = [
    pendingStructuredLaunchesByIdentity.get(launchIdentity(worktreeId, agent)),
    ...[...pendingStructuredLaunchesByIdentity.entries()]
      .filter(([identity]) => identity.startsWith(`${agent}:${worktreeId}:resume:`))
      .map(([, state]) => state)
  ].filter((state): state is StructuredLaunchState => Boolean(state))
  if (states.length === 0) {
    return 'idle'
  }
  return states.some((state) => state.visibilityUnknown) ? 'unknown' : 'pending'
}

export function useStructuredAgentLaunchStatus(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): StructuredAgentLaunchStatus {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentLaunchStatus(worktreeId, agent),
    () => 'idle'
  )
}

export function getPendingStructuredLaunch(identity: string): StructuredLaunchState | undefined {
  return pendingStructuredLaunchesByIdentity.get(identity)
}

export function findPendingStructuredLaunchBySession(
  worktreeId: string,
  sessionId: string
): StructuredLaunchState | undefined {
  return [...pendingStructuredLaunchesByIdentity.values()].find(
    (candidate) =>
      candidate.intent.worktreeId === worktreeId && candidate.intent.sessionId === sessionId
  )
}

export function trackPendingStructuredLaunch(state: StructuredLaunchState): void {
  pendingStructuredLaunchesByIdentity.set(state.identity, state)
  notifyStructuredLaunchListeners()
}

export function forgetPendingStructuredLaunch(state: StructuredLaunchState): void {
  if (pendingStructuredLaunchesByIdentity.get(state.identity) === state) {
    pendingStructuredLaunchesByIdentity.delete(state.identity)
    notifyStructuredLaunchListeners()
  }
}
