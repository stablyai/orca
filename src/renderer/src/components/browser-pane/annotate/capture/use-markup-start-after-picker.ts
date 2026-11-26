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
 * Starts Draw even while Grab or Annotate is on, or still turning off: the picker is removed from the page and a
 * frame painted without its highlight before the screenshot, so Draw never freezes the picker's overlay into it.
 */
export function useMarkupStartAfterPicker({
  markup,
  grab,
  stopPicker,
  webviewRef
}: {
  markup: MarkupModeController
  grab: GrabModeHook
  /** Stops the picker and drops its unsaved card and toast. */
  stopPicker: () => void
  webviewRef: RefObject<Electron.WebviewTag | null>
}): () => Promise<void> {
  const pickerOn = grab.state !== 'idle'
  const { start } = markup
  const { pendingTeardown } = grab
  return useCallback(() => {
    if (!pickerOn && pendingTeardown() === null) {
      return start()
    }
    return start(async () => {
      if (pickerOn) {
        stopPicker()
      }
      const teardown = pendingTeardown()
      // False when the disable failed or a newer request (another viewer re-arming) superseded it.
      if (teardown && !(await withTimeout(teardown, PICKER_TEARDOWN_DEADLINE_MS, false))) {
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
  }, [pendingTeardown, pickerOn, start, stopPicker, webviewRef])
}
