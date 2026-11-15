import { useCallback, useRef } from 'react'

/** A screenshot copy may report only while no newer toast, copy, dismissal or cancel replaced it. */
export function useGrabScreenshotCopy(): {
  claimGrabToast: () => void
  copyGrabScreenshot: (dataUrl: string, onSettled: (copied: boolean) => void) => void
} {
  const ownerRef = useRef(0)
  const claimGrabToast = useCallback((): void => {
    ownerRef.current += 1
  }, [])
  const copyGrabScreenshot = useCallback(
    (dataUrl: string, onSettled: (copied: boolean) => void): void => {
      const owner = ++ownerRef.current
      const settle = (copied: boolean): void => {
        if (owner === ownerRef.current) {
          onSettled(copied)
        }
      }
      void window.api.ui.writeClipboardImage(dataUrl).then(
        () => settle(true),
        () => settle(false)
      )
    },
    []
  )
  return { claimGrabToast, copyGrabScreenshot }
}
