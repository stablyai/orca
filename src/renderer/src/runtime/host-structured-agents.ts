import {
  AGENT_SESSION_AGENTS_METHOD,
  decodeAgentSessionAgentsResult,
  type AgentSessionRegisteredAgent
} from '../../../shared/agent-session-registered-agents'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import { callRuntimeRpc } from './runtime-rpc-client'

/**
 * The structured agents each host registered, as `agentSession.agents` listed them: the one cache
 * every renderer reader asks. Only a host advertising the registered-agents capability is asked;
 * a host that was not, or has not answered, offers only the agents every build ships.
 *
 * Keyed by execution host id and stamped with the runtime instance that answered, so a host that
 * restarted (and may register different agents) reads as unlearned until it answers again.
 */

type HostAgentsEntry = {
  /** The paired host's runtime id when it answered; null for the local runtime, which lives as
   *  long as this renderer's main process. */
  runtimeId: string | null
  agents: readonly AgentSessionRegisteredAgent[]
}

export type HostStructuredAgentsStatuses = ReadonlyMap<string, RuntimeEnvironmentStatus> | undefined

const entries = new Map<string, HostAgentsEntry>()
const inflight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

function publish(): void {
  listeners.forEach((listener) => listener())
}

/** The runtime instance a host's list must come from: null locally, undefined when unknown. */
function currentRuntimeId(
  executionHostId: string,
  statuses: HostStructuredAgentsStatuses
): string | null | undefined {
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind === 'local') {
    return null
  }
  if (host?.kind !== 'runtime') {
    return undefined
  }
  return lastVerifiedRuntimeStatus(statuses?.get(host.environmentId))?.runtimeId
}

/** The agents a host's given runtime listed; undefined when that runtime has not answered. */
export function readHostStructuredAgentsForRuntime(
  executionHostId: string,
  runtimeId: string | null | undefined
): readonly AgentSessionRegisteredAgent[] | undefined {
  const entry = entries.get(executionHostId)
  return entry && runtimeId !== undefined && entry.runtimeId === runtimeId
    ? entry.agents
    : undefined
}

/** The agents this host listed, or undefined when none were learned from its current runtime. */
export function readHostStructuredAgents(
  executionHostId: string,
  statuses: HostStructuredAgentsStatuses
): readonly AgentSessionRegisteredAgent[] | undefined {
  return readHostStructuredAgentsForRuntime(
    executionHostId,
    currentRuntimeId(executionHostId, statuses)
  )
}

/** Asks a host for its agents unless its current runtime already answered. Never rejects: a
 *  failed read leaves the host unlearned, and the next status change asks again. */
export function loadHostStructuredAgents(
  executionHostId: string,
  hostCapabilities: readonly string[] | null | undefined,
  runtimeId: string | null
): Promise<void> {
  const host = parseExecutionHostId(executionHostId)
  if (
    (host?.kind !== 'local' && host?.kind !== 'runtime') ||
    !hostCapabilities?.includes(STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY) ||
    entries.get(executionHostId)?.runtimeId === runtimeId
  ) {
    return Promise.resolve()
  }
  const key = `${executionHostId}\u0000${runtimeId ?? ''}`
  const pending = inflight.get(key)
  if (pending) {
    return pending
  }
  const read = callRuntimeRpc<unknown>(
    host.kind === 'local'
      ? { kind: 'local' }
      : { kind: 'environment', environmentId: host.environmentId },
    AGENT_SESSION_AGENTS_METHOD,
    {},
    runtimeId === null ? {} : { expectedEnvironmentRuntimeId: runtimeId }
  )
    .then((result) => {
      const agents = decodeAgentSessionAgentsResult(result)
      if (agents) {
        entries.set(executionHostId, { runtimeId, agents })
        publish()
      }
    })
    .catch((error: unknown) => {
      console.warn('[native-chat] could not read the host structured agents', error)
    })
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, read)
  return read
}

/** Drops hosts no longer paired; a stale runtime is already ignored by the reader. */
export function retainHostStructuredAgents(executionHostIds: ReadonlySet<string>): void {
  let removed = false
  for (const id of entries.keys()) {
    if (!executionHostIds.has(id)) {
      entries.delete(id)
      removed = true
    }
  }
  if (removed) {
    publish()
  }
}

export function subscribeHostStructuredAgents(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function resetHostStructuredAgentsForTests(): void {
  entries.clear()
  inflight.clear()
  publish()
}
