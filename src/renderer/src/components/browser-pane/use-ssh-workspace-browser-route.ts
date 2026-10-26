import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useWorktreeHostConnection } from '@/lib/worktree-host-connection-phase'
import { resolveSshWorkspaceBrowserRouteEligibility } from '@/lib/ssh-workspace-browser-route-eligibility'
import type { BrowserLoadFailureRoute } from '../../../../shared/browser-load-failure'

export type SshWorkspaceBrowserRouteErrorKind = 'forwarding-blocked' | 'ssh-unavailable' | 'unknown'

export type SshWorkspaceBrowserRouteState =
  | { kind: 'unrouted' }
  | { kind: 'preparing' }
  | { kind: 'ready'; partition: string; targetId: string; expectedSshTargetGeneration?: number }
  | { kind: 'error'; errorKind: SshWorkspaceBrowserRouteErrorKind; message: string }

export function classifySshWorkspaceBrowserRouteError(
  message: string
): SshWorkspaceBrowserRouteErrorKind {
  if (message.includes('browser_local_route_forwarding_blocked')) {
    return 'forwarding-blocked'
  }
  if (
    message.includes('browser_local_route_ssh_unavailable') ||
    message.includes('browser_tunnel_execution_host_unavailable')
  ) {
    return 'ssh-unavailable'
  }
  return 'unknown'
}

/** Mount only a proxy-verified partition; preparing/failed routes must never fall back to local egress. Unrouted access requires an explicit opt-out. */
export function useSshWorkspaceBrowserRoute(
  worktreeId: string,
  sessionProfileId: string | null
): {
  state: SshWorkspaceBrowserRouteState
  targetId: string | null
  retry: () => void
  tryWithoutProbe: () => void
  browseFromThisDevice: () => void
} {
  const executionHostId = useAppStore((s) => getExecutionHostIdForWorktree(s, worktreeId))
  const browserRoutingSettings = useAppStore((s) => s.settings)
  const environments = useAppStore((s) => s.runtimeEnvironments)
  const probeSkippedTargetIds = useAppStore(
    (s) => s.settings?.browserSshWorkspaceRoutingProbeSkippedTargetIds
  )
  const updateSettings = useAppStore((s) => s.updateSettings)
  const routeEligibility = resolveSshWorkspaceBrowserRouteEligibility(
    executionHostId,
    browserRoutingSettings,
    environments
  )
  const sshTargetId = routeEligibility?.targetId ?? null
  const targetId = routeEligibility?.eligible === true ? routeEligibility.targetId : null
  const expectedSshTargetGeneration = routeEligibility?.expectedSshTargetGeneration
  const browserProfileId = sessionProfileId ?? 'default'
  const [attempt, setAttempt] = useState<{ count: number; skipProbe: boolean }>({
    count: 0,
    skipProbe: false
  })
  const [state, setState] = useState<SshWorkspaceBrowserRouteState>(
    targetId ? { kind: 'preparing' } : { kind: 'unrouted' }
  )
  const hostConnection = useWorktreeHostConnection(worktreeId, targetId)
  const routeHost =
    targetId !== null && hostConnection.targetId === targetId ? hostConnection : null
  // Dialing must preserve ready/error views; unrouted or wrong-target state remains unsettled until this target is answered.
  const routeReady =
    state.kind === 'ready' &&
    state.targetId === targetId &&
    state.expectedSshTargetGeneration === expectedSshTargetGeneration
  const awaitingHost = routeHost?.phase === 'connecting' && state.kind !== 'error' && !routeReady
  const connectedHostEpoch = routeHost?.connectedEpoch ?? null
  const [seenConnectedHostEpoch, setSeenConnectedHostEpoch] = useState(connectedHostEpoch)
  if (connectedHostEpoch !== seenConnectedHostEpoch) {
    setSeenConnectedHostEpoch(connectedHostEpoch)
    // A connected host epoch rechecks failed/unsettled routes while preserving the user’s probe choice.
    if (connectedHostEpoch !== null && !routeReady) {
      setAttempt((current) => ({ ...current, count: current.count + 1 }))
    }
  }

  // Persist “Try anyway”: forwarding may work while the loopback probe is forbidden; do not re-prompt every launch.
  const skipProbe = attempt.skipProbe || probeSkippedTargetIds?.includes(targetId ?? '') === true
  useEffect(() => {
    if (!targetId) {
      setState({ kind: 'unrouted' })
      return
    }
    setState({ kind: 'preparing' })
    // Preparing during dial can only fail ssh-unavailable; wait for the connected transition.
    if (awaitingHost) {
      return
    }
    let cancelled = false
    window.api.browser
      .prepareSshWorkspacePartition({
        targetId,
        browserProfileId,
        ...(expectedSshTargetGeneration !== undefined ? { expectedSshTargetGeneration } : {}),
        ...(skipProbe ? { skipProbe: true } : {})
      })
      .then((result) => {
        if (!cancelled) {
          setState({
            kind: 'ready',
            partition: result.partition,
            targetId,
            ...(expectedSshTargetGeneration !== undefined ? { expectedSshTargetGeneration } : {})
          })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error)
          setState({
            kind: 'error',
            errorKind: classifySshWorkspaceBrowserRouteError(message),
            message
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [targetId, expectedSshTargetGeneration, browserProfileId, attempt, skipProbe, awaitingHost])

  // Derive target changes synchronously; stale unrouted/other-target state could mount a local-egress guest before the effect corrects it.
  const effectiveState: SshWorkspaceBrowserRouteState = !targetId
    ? { kind: 'unrouted' }
    : awaitingHost || state.kind === 'unrouted' || (state.kind === 'ready' && !routeReady)
      ? { kind: 'preparing' }
      : state
  const rederive = (nextSkipProbe: boolean): void => {
    // Set preparing with the attempt so the effect can wait for dialing without cancelling its own prepare.
    setState({ kind: 'preparing' })
    setAttempt((current) => ({ count: current.count + 1, skipProbe: nextSkipProbe }))
  }
  return {
    state: effectiveState,
    targetId: sshTargetId,
    retry: () => rederive(false),
    tryWithoutProbe: () => {
      // Persist the override so this host isn't re-nagged on every launch.
      if (sshTargetId && probeSkippedTargetIds?.includes(sshTargetId) !== true) {
        updateSettings({
          browserSshWorkspaceRoutingProbeSkippedTargetIds: [
            ...(probeSkippedTargetIds ?? []),
            sshTargetId
          ]
        })
      }
      rederive(true)
    },
    browseFromThisDevice: () => {
      if (!sshTargetId) {
        return
      }
      const disabled = browserRoutingSettings?.browserSshWorkspaceRoutingDisabledTargetIds ?? []
      if (!disabled.includes(sshTargetId)) {
        updateSettings({
          browserSshWorkspaceRoutingDisabledTargetIds: [...disabled, sshTargetId]
        })
      }
    }
  }
}

function useSshWorkspaceRouteTargetId(worktreeId: string): string | null {
  const executionHostId = useAppStore((s) => getExecutionHostIdForWorktree(s, worktreeId))
  const browserRoutingSettings = useAppStore((s) => s.settings)
  const environments = useAppStore((s) => s.runtimeEnvironments)
  return (
    resolveSshWorkspaceBrowserRouteEligibility(
      executionHostId,
      browserRoutingSettings,
      environments
    )?.targetId ?? null
  )
}

/** Revoke persisted “Try anyway” on load failure so route hooks probe again and can explain blocked forwarding. */
export function useSshWorkspaceProbeSkipRecheck(worktreeId: string): (() => void) | null {
  const probeSkippedTargetIds = useAppStore(
    (s) => s.settings?.browserSshWorkspaceRoutingProbeSkippedTargetIds
  )
  const updateSettings = useAppStore((s) => s.updateSettings)
  const targetId = useSshWorkspaceRouteTargetId(worktreeId)
  if (!targetId || probeSkippedTargetIds?.includes(targetId) !== true) {
    return null
  }
  return () =>
    updateSettings({
      browserSshWorkspaceRoutingProbeSkippedTargetIds: (probeSkippedTargetIds ?? []).filter(
        (id) => id !== targetId
      )
    })
}

export function useSshWorkspaceBrowserLoadFailureRoute(worktreeId: string): {
  route: BrowserLoadFailureRoute | null
  recheck: (() => void) | null
} {
  const recheck = useSshWorkspaceProbeSkipRecheck(worktreeId)
  const targetId = useSshWorkspaceRouteTargetId(worktreeId)
  const routeConnected = useWorktreeHostConnection(worktreeId, targetId).phase === 'connected'
  // Why: after "Try anyway" nothing proved the host forwards ports, so a SOCKS failure can't mean "nothing is running".
  return { route: recheck ? null : { routed: true, routeConnected }, recheck }
}
