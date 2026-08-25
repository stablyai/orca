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
}

export function useRemoteBrowserStreamActivation({
  activeRuntimeEnvironmentId,
  browserPageId,
  clearPendingRemoteWheel,
  isActive,
  lifecycle,
  reopenNonce,
  runtimeWorktree
}: RemoteBrowserStreamActivationOptions): void {
  const windowVisibleForStream = useWindowStreamVisible()

  useEffect(() => {
    if (!isActive || !windowVisibleForStream) {
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
    windowVisibleForStream
  ])
}
