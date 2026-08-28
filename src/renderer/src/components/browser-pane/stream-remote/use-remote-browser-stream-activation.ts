import { useEffect } from 'react'
import { useWindowStreamVisible } from '@/hooks/use-window-stream-visibility'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'

type RemoteBrowserStreamActivationOptions = {
  activeRuntimeEnvironmentId: string
  browserPageId: string
  clearPendingRemoteWheel: () => void
  isActive: boolean
  lifecycle: Pick<RemoteBrowserStreamLifecycle, 'open'>
  reopenNonce: number
  runtimeWorktree: string
  /** The page is an optimistic stage; the host has not published it, so there is nothing to open. */
  stagedPage?: boolean
}

export function useRemoteBrowserStreamActivation({
  activeRuntimeEnvironmentId,
  browserPageId,
  clearPendingRemoteWheel,
  isActive,
  lifecycle,
  reopenNonce,
  runtimeWorktree,
  stagedPage = false
}: RemoteBrowserStreamActivationOptions): void {
  const windowVisibleForStream = useWindowStreamVisible()

  useEffect(() => {
    // Why: opening a staged page would create a second host tab racing the create that staged
    // it, and a failed open would close the tab out from under the user.
    if (!isActive || !windowVisibleForStream || stagedPage) {
      return
    }
    const closeStream = lifecycle.open()
    return () => {
      closeStream()
      clearPendingRemoteWheel()
    }
  }, [
    // The stable lifecycle reads identity through refs; these values trigger the required reopen.
    activeRuntimeEnvironmentId,
    browserPageId,
    clearPendingRemoteWheel,
    isActive,
    lifecycle,
    reopenNonce,
    runtimeWorktree,
    stagedPage,
    windowVisibleForStream
  ])
}
