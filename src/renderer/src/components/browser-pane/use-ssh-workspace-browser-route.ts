import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { resolveSshWorkspaceBrowserRouteEligibility } from '@/lib/ssh-workspace-browser-route-eligibility'

export type SshWorkspaceBrowserRouteErrorKind = 'forwarding-blocked' | 'ssh-unavailable' | 'unknown'

export type SshWorkspaceBrowserRouteState =
  | { kind: 'unrouted' }
  | { kind: 'preparing' }
  | { kind: 'ready'; partition: string; targetId: string }
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

/**
 * Resolves the proxy-verified partition an SSH workspace's browser page must
 * mount on. Fail-closed: while preparing or failed, the caller must not mount
 * a webview at all — falling back to a profile partition would silently browse
 * from the local machine instead of the SSH host. The only unrouted paths are
 * explicit: the global setting, or a per-target opt-out the user chose from
 * the error card.
 */
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
  const probeSkippedTargetIds = useAppStore(
    (s) => s.settings?.browserSshWorkspaceRoutingProbeSkippedTargetIds
  )
  const updateSettings = useAppStore((s) => s.updateSettings)
  const routeEligibility = resolveSshWorkspaceBrowserRouteEligibility(
    executionHostId,
    browserRoutingSettings
  )
  const sshTargetId = routeEligibility?.targetId ?? null
  const targetId = routeEligibility?.eligible === true ? routeEligibility.targetId : null
  const browserProfileId = sessionProfileId ?? 'default'
  const [attempt, setAttempt] = useState<{ count: number; skipProbe: boolean }>({
    count: 0,
    skipProbe: false
  })
  const [state, setState] = useState<SshWorkspaceBrowserRouteState>(
    targetId ? { kind: 'preparing' } : { kind: 'unrouted' }
  )

  // Why: a persisted "Try anyway" means the user vouched for this host once
  // (e.g. PermitOpen allows their sites while the loopback probe is refused);
  // re-nagging every launch would train them to distrust the card.
  const skipProbe = attempt.skipProbe || probeSkippedTargetIds?.includes(targetId ?? '') === true
  useEffect(() => {
    if (!targetId) {
      setState({ kind: 'unrouted' })
      return
    }
    let cancelled = false
    setState({ kind: 'preparing' })
    window.api.browser
      .prepareSshWorkspacePartition({
        targetId,
        browserProfileId,
        ...(skipProbe ? { skipProbe: true } : {})
      })
      .then((result) => {
        if (!cancelled) {
          setState({ kind: 'ready', partition: result.partition, targetId })
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
  }, [targetId, browserProfileId, attempt, skipProbe])

  // Why (review P1-1): `state` lags one commit behind a targetId transition on
  // an already-mounted instance; returning stale 'unrouted' (or a stale
  // 'ready' minted for a different target) for that render would mount a
  // webview with the wrong egress before the effect corrects it. The
  // routed/unrouted decision must be derived from targetId in-render.
  const effectiveState: SshWorkspaceBrowserRouteState = !targetId
    ? { kind: 'unrouted' }
    : state.kind === 'unrouted' || (state.kind === 'ready' && state.targetId !== targetId)
      ? { kind: 'preparing' }
      : state
  return {
    state: effectiveState,
    targetId: sshTargetId,
    retry: () => setAttempt((current) => ({ count: current.count + 1, skipProbe: false })),
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
      setAttempt((current) => ({ count: current.count + 1, skipProbe: true }))
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

/**
 * The undo for a persisted "Try anyway", surfaced where its cost shows up: on
 * a routed page's load-failure overlay. Returns null unless this workspace's
 * SSH target carries the skip; clearing it flips the route hooks back to
 * probing, which resurfaces the classified card if forwarding is still blocked.
 */
export function useSshWorkspaceProbeSkipRecheck(worktreeId: string): (() => void) | null {
  const executionHostId = useAppStore((s) => getExecutionHostIdForWorktree(s, worktreeId))
  const browserRoutingSettings = useAppStore((s) => s.settings)
  const probeSkippedTargetIds = useAppStore(
    (s) => s.settings?.browserSshWorkspaceRoutingProbeSkippedTargetIds
  )
  const updateSettings = useAppStore((s) => s.updateSettings)
  const targetId =
    resolveSshWorkspaceBrowserRouteEligibility(executionHostId, browserRoutingSettings)?.targetId ??
    null
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
