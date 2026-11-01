import { useEffect, type RefObject } from 'react'
import { getRemoteBrowserHistoryMethod } from './remote-browser-page-input-model'

type RemoteHistoryMethod = NonNullable<ReturnType<typeof getRemoteBrowserHistoryMethod>>

/** Mouse back/forward buttons over a streamed page step its history on the host. */
export function useRemoteBrowserPagePointerHistory({
  isActive,
  remoteViewportRef,
  runRemoteNavigation
}: {
  isActive: boolean
  remoteViewportRef: RefObject<HTMLDivElement | null>
  runRemoteNavigation: (method: RemoteHistoryMethod) => Promise<void> | void
}): void {
  useEffect(() => {
    const viewport = remoteViewportRef.current
    if (!isActive || !viewport) {
      return
    }
    // Why both: in the paired web client the outer browser would also step its own history unless
    // the press is claimed.
    const claimSideButton = (event: MouseEvent): RemoteHistoryMethod | null => {
      const method = getRemoteBrowserHistoryMethod(event.button)
      if (method) {
        event.preventDefault()
      }
      return method
    }
    const handleMouseUp = (event: MouseEvent): void => {
      const method = claimSideButton(event)
      if (method) {
        void runRemoteNavigation(method)
      }
    }
    viewport.addEventListener('mousedown', claimSideButton)
    viewport.addEventListener('mouseup', handleMouseUp)
    return () => {
      viewport.removeEventListener('mousedown', claimSideButton)
      viewport.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isActive, remoteViewportRef, runRemoteNavigation])
}
