import { useRef } from 'react'
import { readSideButtonTransition } from '@/lib/side-button-transition'

const REMOTE_HISTORY_METHODS = { 3: 'browser.back', 4: 'browser.forward' } as const

/** Mouse Back/Forward over the remote frame: page history, owned by the surface the press began on. */
export function useRemoteBrowserSideButtonPress({
  enqueueRemoteInput,
  runRemoteNavigation
}: {
  enqueueRemoteInput: (operation: () => Promise<void>) => Promise<void>
  runRemoteNavigation: (method: 'browser.back' | 'browser.forward') => Promise<void> | void
}): {
  /** True when the event was a side-button transition, which never reaches the remote page. */
  claimSideButton: (event: React.PointerEvent<HTMLImageElement>) => boolean
  handleRemoteLostPointerCapture: () => void
} {
  const pendingButtonRef = useRef<number | null>(null)

  const claimSideButton = (event: React.PointerEvent<HTMLImageElement>): boolean => {
    const transition = readSideButtonTransition(event.nativeEvent)
    if (!transition) {
      return false
    }
    // Why: navigation fires on release; cancel both edges so neither reaches the remote page.
    event.preventDefault()
    if (transition.phase === 'press') {
      // Why capture: mouse pointers get no implicit capture, so a release over chrome would be lost.
      event.currentTarget.setPointerCapture?.(event.pointerId)
      pendingButtonRef.current = transition.button
      return true
    }
    // Why: a press that began over Orca chrome is not this page's to navigate.
    const startedHere = pendingButtonRef.current === transition.button
    pendingButtonRef.current = null
    if (startedHere) {
      const method = REMOTE_HISTORY_METHODS[transition.button]
      // Why queue: a click still in flight must land before Back, or Back undoes the wrong entry.
      void enqueueRemoteInput(async () => {
        await runRemoteNavigation(method)
      })
    }
    return true
  }

  // Why: pointercancel or an interrupted capture ends the press without a navigating release.
  const handleRemoteLostPointerCapture = (): void => {
    pendingButtonRef.current = null
  }

  return { claimSideButton, handleRemoteLostPointerCapture }
}
