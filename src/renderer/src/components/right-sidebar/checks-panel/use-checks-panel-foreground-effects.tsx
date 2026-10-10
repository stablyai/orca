import { useEffect } from 'react'
import { shouldPollChecksPanelRuntimeSshStatus } from '../checks-panel-git-status-snapshot'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'

type ChecksPanelForegroundEffectsInput = Pick<
  ChecksPanelControllerState,
  'isPanelVisible' | 'repoConnectionId' | 'runtimeEnvironmentId' | 'setGitStatusRefreshNonce'
>

const RUNTIME_SSH_STATUS_REFRESH_MS = 3000

export function useChecksPanelForegroundEffects({
  isPanelVisible,
  repoConnectionId,
  runtimeEnvironmentId,
  setGitStatusRefreshNonce
}: ChecksPanelForegroundEffectsInput) {
  useEffect(() => {
    if (
      !shouldPollChecksPanelRuntimeSshStatus({
        isPanelVisible,
        runtimeEnvironmentId,
        repoConnectionId
      })
    ) {
      return undefined
    }
    let skippedInitialRun = false
    return installWindowVisibilityInterval({
      run: () => {
        if (!skippedInitialRun) {
          skippedInitialRun = true
          return
        }
        setGitStatusRefreshNonce((value) => value + 1)
      },
      jitterOnVisible: true,
      intervalMs: RUNTIME_SSH_STATUS_REFRESH_MS
    })
  }, [isPanelVisible, repoConnectionId, runtimeEnvironmentId, setGitStatusRefreshNonce])
}
