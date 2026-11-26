import { useCallback, type RefObject } from 'react'
import { withTimeout } from '../../../../../../shared/concurrency/promise-timeout-fallback'
import type { GrabModeHook } from '../grab/useGrabMode'
import type { MarkupModeController } from './useMarkupMode'

// Teardown waits for a loading page to finish; past this Draw reports a failed capture instead of hanging.
const PICKER_TEARDOWN_DEADLINE_MS = 10_000
const GUEST_PAINT_WAIT_MS = 500
const TWO_GUEST_FRAMES_SCRIPT =
  'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'

/**
 * Starts Draw even while Grab or Annotate is on: the picker is removed from the page and a frame painted
 * without its highlight before the screenshot, so Draw never freezes the picker's overlay into the image.
 */
export function useMarkupStartAfterPicker({
  browserPageId,
  markup,
  grab,
  stopPicker,
  webviewRef
}: {
  browserPageId: string
  markup: MarkupModeController
  grab: GrabModeHook
  /** Stops the picker and drops its unsaved card and toast. */
  stopPicker: () => void
  webviewRef: RefObject<Electron.WebviewTag | null>
}): () => Promise<void> {
  const pickerOn = grab.state !== 'idle'
  const { start } = markup
  const { setGrabMode } = grab.transport
  return useCallback(() => {
    if (!pickerOn) {
      return start()
    }
    return start(async () => {
      stopPicker()
      // Main serializes a page's grab mode changes, so this settles after the stop above has torn down.
      const stopped = await withTimeout(
        setGrabMode({ browserPageId, enabled: false }),
        PICKER_TEARDOWN_DEADLINE_MS,
        { ok: false, reason: 'injection-failed' }
      )
      if (!stopped.ok) {
        return false
      }
      const webview = webviewRef.current
      if (webview) {
        await withTimeout(
          webview.executeJavaScript(TWO_GUEST_FRAMES_SCRIPT),
          GUEST_PAINT_WAIT_MS,
          false
        )
      }
      return true
    })
  }, [browserPageId, pickerOn, setGrabMode, start, stopPicker, webviewRef])
}
