import {
  AGENT_SESSION_AGENTS_METHOD,
  decodeAgentSessionAgentsResult,
  type AgentSessionRegisteredAgent
} from '../../../shared/agent-session/agent-session-registered-agents'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import { ensureLocalRuntimeCapabilities } from './local-runtime-capabilities'
import { callRuntimeRpc } from './runtime-rpc-client'

/** One registered-agent cache per execution host/runtime. Query only capable hosts; unknown/unsupported hosts offer built-ins. Runtime changes invalidate learned lists until that instance answers. */

type HostAgentsEntry = {
  /** The paired host's runtime id when it answered; null for the local runtime, which lives as
   *  long as this renderer's main process. */
  runtimeId: string | null
  agents: readonly AgentSessionRegisteredAgent[]
}

export type HostStructuredAgentsStatuses = ReadonlyMap<string, RuntimeEnvironmentStatus> | undefined

const entries = new Map<string, HostAgentsEntry>()
const inflight = new Map<string, Promise<void>>()
/** Host runtimes whose last read failed, keyed like `inflight`: unlearned but not loading. */
const failed = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

function publish(): void {
  version += 1
  listeners.forEach((listener) => listener())
}

/** Changes whenever any host's list does; a React snapshot for `subscribeHostStructuredAgents`. */
export function hostStructuredAgentsVersion(): number {
  return version
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

/** Whether the given runtime's last agents read failed, as opposed to not having answered yet. */
export function hostStructuredAgentsReadFailed(
  executionHostId: string,
  runtimeId: string | null
): boolean {
  return failed.has(hostRuntimeKey(executionHostId, runtimeId))
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
  const key = hostRuntimeKey(executionHostId, runtimeId)
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
      if (!agents) {
        throw new Error('Invalid registered-agent response')
      }
      failed.delete(key)
      entries.set(executionHostId, { runtimeId, agents })
      publish()
    })
    .catch((error: unknown) => {
      console.warn('[native-chat] could not read the host structured agents', error)
      failed.add(key)
      publish()
    })
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, read)
  return read
}

/** Retry unlearned agents at launch: once-per-runtime startup reads can fail or precede capabilities and otherwise exclude that host for the whole session. */
export async function relearnHostStructuredAgents(
  executionHostId: string,
  hostCapabilities: readonly string[] | null | undefined,
  statuses: HostStructuredAgentsStatuses
): Promise<void> {
  const runtimeId = currentRuntimeId(executionHostId, statuses)
  if (runtimeId === undefined || readHostStructuredAgentsForRuntime(executionHostId, runtimeId)) {
    return
  }
  const capabilities =
    runtimeId === null && !hostCapabilities
      ? await ensureLocalRuntimeCapabilities()
      : hostCapabilities
  await loadHostStructuredAgents(executionHostId, capabilities, runtimeId)
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

function hostRuntimeKey(executionHostId: string, runtimeId: string | null): string {
  return `${executionHostId}\u0000${runtimeId ?? ''}`
}

export function resetHostStructuredAgentsForTests(): void {
  entries.clear()
  inflight.clear()
  failed.clear()
  publish()
}

export function hostStructuredAgentsCatalogUnlearned(
  host: string,
  runtimeId: string | null | undefined,
  capabilities: readonly string[] | null | undefined
): boolean {
  return (
    runtimeId !== undefined &&
    capabilities?.includes(STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY) ===
      true &&
    !readHostStructuredAgentsForRuntime(host, runtimeId) &&
    !hostStructuredAgentsReadFailed(host, runtimeId)
  )
}
