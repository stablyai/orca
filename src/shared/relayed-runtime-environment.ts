import { parseExecutionHostId } from './execution-host'

const RELAYED_RUNTIME_ENVIRONMENT_PREFIX = 'relay:'

/** A managed server reached through a paired server's relay, as one environment id for the renderer. */
export type RelayedRuntimeEnvironment = {
  /** The paired server that relays (A). */
  ownerEnvironmentId: string
  /** A's pairing the id was minted for; a re-pair under the same id may be another machine. */
  ownerPairingRevision: number
  /** A's id for the managed server (`runtime:<id on A>`), sent as the request's `executionHost`. */
  executionHost: `runtime:${string}`
}

/** Read-only methods a relayed server answers: execution-host routes on A that change nothing on B. */
export const RELAYED_RUNTIME_READ_METHODS: ReadonlySet<string> = new Set([
  'status.get',
  'files.list',
  'files.read',
  'files.readChunk',
  'files.readDir',
  'files.readPreview',
  'files.searchPaths',
  'files.stat',
  'git.branchDiff',
  'git.diff',
  'git.history',
  'git.status',
  'session.tabs.list',
  'terminal.agentStatus',
  'worktree.ps',
  'worktree.show'
])

/** Owner-qualified: two paired servers may each call a different machine `runtime:vm-1`. */
export function toRelayedRuntimeEnvironmentId(relayed: RelayedRuntimeEnvironment): string {
  return [
    `${RELAYED_RUNTIME_ENVIRONMENT_PREFIX}${encodeURIComponent(relayed.ownerEnvironmentId)}`,
    String(relayed.ownerPairingRevision),
    encodeURIComponent(relayed.executionHost)
  ].join('/')
}

export function isRelayedRuntimeEnvironmentId(environmentId: string): boolean {
  return environmentId.startsWith(RELAYED_RUNTIME_ENVIRONMENT_PREFIX)
}

/** Null for anything but a well-formed id from {@link toRelayedRuntimeEnvironmentId}. */
export function parseRelayedRuntimeEnvironmentId(
  environmentId: string
): RelayedRuntimeEnvironment | null {
  if (!isRelayedRuntimeEnvironmentId(environmentId)) {
    return null
  }
  const parts = environmentId.slice(RELAYED_RUNTIME_ENVIRONMENT_PREFIX.length).split('/')
  if (parts.length !== 3 || !/^\d+$/.test(parts[1])) {
    return null
  }
  try {
    const ownerEnvironmentId = decodeURIComponent(parts[0])
    const host = parseExecutionHostId(decodeURIComponent(parts[2]))
    if (!ownerEnvironmentId || host?.kind !== 'runtime') {
      return null
    }
    return {
      ownerEnvironmentId,
      ownerPairingRevision: Number(parts[1]),
      executionHost: host.id
    }
  } catch {
    return null
  }
}
