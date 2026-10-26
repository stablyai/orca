import { useEffect, useMemo } from 'react'
import { useAppStore } from '../store'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import {
  isConnectedRuntimeHostState,
  runtimeHostConnectionStateForEntry
} from '@/runtime/runtime-host-connection-state'
import {
  getLandingPreflightIssues,
  hasGitHubBackedProject,
  type PreflightIssue
} from './landing-preflight-issues'

export function useLandingPreflightRuntime(): { preflightIssues: PreflightIssue[] } {
  const repos = useAppStore((s) => s.repos)
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const invalidatePreflightStatus = useAppStore((s) => s.invalidatePreflightStatus)
  const activeRuntimeState = useAppStore((s) => {
    const environmentId = s.settings?.activeRuntimeEnvironmentId?.trim()
    if (!environmentId) {
      return 'local'
    }
    const runtimeStatus = s.runtimeStatusByEnvironmentId.get(environmentId)
    // Use transport reachability: an unverifiable probe nulls status without disconnecting the host.
    const reachability = runtimeStatus
      ? isConnectedRuntimeHostState(runtimeHostConnectionStateForEntry(runtimeStatus))
        ? 'reachable'
        : 'unreachable'
      : 'unknown'
    return `${environmentId}:${runtimeStatus?.connectionGeneration ?? 0}:${reachability}`
  })

  const hasGitHubProject = useMemo(() => hasGitHubBackedProject(repos), [repos])
  const preflightIssues = useMemo(
    () =>
      preflightStatus
        ? getLandingPreflightIssues(preflightStatus, {
            hasGitHubBackedProject: hasGitHubProject
          })
        : [],
    [preflightStatus, hasGitHubProject]
  )

  useEffect(() => {
    if (activeRuntimeState !== 'local' && !activeRuntimeState.endsWith(':reachable')) {
      invalidatePreflightStatus()
      return
    }

    void refreshPreflightStatus()
    const handleWindowActive = (): void => {
      if (document.visibilityState === 'visible') {
        void refreshPreflightStatus({ force: true })
      }
    }
    document.addEventListener('visibilitychange', handleWindowActive)
    window.addEventListener('focus', handleWindowActive)
    return () => {
      document.removeEventListener('visibilitychange', handleWindowActive)
      window.removeEventListener('focus', handleWindowActive)
    }
  }, [activeRuntimeState, invalidatePreflightStatus, refreshPreflightStatus])

  useEffect(() => {
    if (preflightIssues.length === 0) {
      return
    }
    // Suspend hidden-window polling; visibility/focus handlers already force-refresh on reveal.
    return installWindowVisibilityInterval({
      run: () => {
        void refreshPreflightStatus({ force: true })
      },
      runOnVisible: () => {},
      intervalMs: 30000
    })
  }, [preflightIssues.length, refreshPreflightStatus])

  return { preflightIssues }
}
