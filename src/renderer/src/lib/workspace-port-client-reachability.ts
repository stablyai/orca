import { useMemo } from 'react'
import {
  preferredRuntimeEndpoint,
  type PublicKnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import type { WorkspacePort } from '../../../shared/workspace-ports'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  runtimeTargetForExecutionHostId,
  type RuntimeClientTarget
} from '@/runtime/runtime-client-target'
import {
  getExecutionHostIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { runtimeTargetForWorkspacePortScanKey } from './workspace-port-actions'
import { addressForPort, clientReachableBrowserUrlForPort } from './workspace-port-urls'

// Why: the endpoint list already reaches the renderer with tokens redacted, so the
// address this client dials is available without new IPC. This is the single source
// for both the imperative open action and any reactive surface that labels a row.
type ClientReachableUrlLookupState = {
  runtimeEnvironments?: readonly PublicKnownRuntimeEnvironment[]
}

/** URL for a remote workspace's port that this machine can open directly, or null when
 *  there is none. Local targets return null: their ports are already on this machine
 *  and the existing local paths own them. */
export function resolveClientReachableUrlForPort(
  state: ClientReachableUrlLookupState,
  port: WorkspacePort,
  target: RuntimeClientTarget | null
): string | null {
  if (target?.kind !== 'environment') {
    return null
  }
  const environment = (state.runtimeEnvironments ?? []).find(
    (entry) => entry.id === target.environmentId
  )
  if (!environment) {
    return null
  }
  // Why: an ssh-tunnelled pairing dials this client's own loopback, so its address
  // cannot reach the runtime's dev servers. The endpoint classification catches this
  // too; the declared dependency is the explicit signal and is checked first.
  if (environment.connectionDependency === 'ssh-tunnel') {
    return null
  }
  return clientReachableBrowserUrlForPort(
    port,
    preferredRuntimeEndpoint(environment)?.endpoint ?? null
  )
}

// Why not URL.host: it omits a default port, so a listener on :80 or :443 would render as
// a bare hostname while every other row renders `host:port`. The listener's own port is
// the honest one to show — the reachable URL is built from it, and an advertised origin
// only reaches this branch when its port already matches the listener.
function reachableAddress(reachableUrl: string | null, port: WorkspacePort): string | null {
  if (!reachableUrl) {
    return null
  }
  try {
    const hostname = new URL(reachableUrl).hostname
    return hostname ? `${hostname}:${port.port}` : null
  } catch {
    return null
  }
}

export type PortClientReachability = {
  /** Host that actually reported this listener — not necessarily the active workspace's. */
  runtimeTarget: RuntimeClientTarget | null
  /** True when that host is a paired remote one, so a plain click has no direct URL and
   *  always lands in Orca's embedded browser. Drives the modifier's meaning. */
  remoteHost: boolean
  /** The `host:port` to display and copy, already falling back to the OS-derived one. */
  address: string
  /** URL this machine can open directly, or null when none can be named. */
  reachableUrl: string | null
  /** Whether the system-browser modifier has anywhere to go for this port. */
  systemBrowserAvailable: boolean
}

function portOwnerWorktreeId(
  port: WorkspacePort | null,
  activeWorktreeId: string | null | undefined
): string | null {
  return port?.kind === 'workspace' ? port.owner.worktreeId : (activeWorktreeId ?? null)
}

// Why the scan key wins: in the merged all-hosts view a row's host is not the active
// workspace's, and a container or external port carries no owner to ask. The key stamped
// at merge time is the only fact that names the host that reported the listener.
function portRuntimeTarget(
  port: WorkspacePort | null,
  executionHostId: ExecutionHostId | null
): RuntimeClientTarget | null {
  const scanKeyTarget = runtimeTargetForWorkspacePortScanKey(port?.hostScanKey)
  if (scanKeyTarget) {
    return scanKeyTarget
  }
  return executionHostId ? runtimeTargetForExecutionHostId(executionHostId) : null
}

function portClientReachability(
  port: WorkspacePort | null,
  runtimeTarget: RuntimeClientTarget | null,
  state: ClientReachableUrlLookupState
): PortClientReachability {
  const reachableUrl = port ? resolveClientReachableUrlForPort(state, port, runtimeTarget) : null
  const remoteHost = runtimeTarget?.kind === 'environment'
  return {
    runtimeTarget,
    remoteHost,
    reachableUrl,
    address: (port && reachableAddress(reachableUrl, port)) || (port ? addressForPort(port) : ''),
    systemBrowserAvailable: !remoteHost || reachableUrl !== null
  }
}

export type PortClientReachabilityState = WorktreeRuntimeOwnerState & ClientReachableUrlLookupState

/** Imperative form for click handlers that already hold the store snapshot. */
export function resolvePortClientReachability(
  state: PortClientReachabilityState,
  port: WorkspacePort
): PortClientReachability {
  const worktreeId = portOwnerWorktreeId(port, state.activeWorktreeId)
  return portClientReachability(
    port,
    portRuntimeTarget(port, getExecutionHostIdForWorktree(state, worktreeId)),
    state
  )
}

/**
 * Everything a port row needs to name itself consistently. One hook rather than four
 * hand-copied derivations, because the whole point of the feature is that what a row
 * shows, what it copies and what it opens cannot drift apart.
 */
export function usePortClientReachability(port: WorkspacePort | null): PortClientReachability {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreeId = portOwnerWorktreeId(port, activeWorktreeId)
  const executionHostId = useAppStore((s) => getExecutionHostIdForWorktree(s, worktreeId))
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  return useMemo(
    () =>
      portClientReachability(port, portRuntimeTarget(port, executionHostId), {
        runtimeEnvironments
      }),
    [executionHostId, port, runtimeEnvironments]
  )
}
