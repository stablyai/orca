import { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { DesktopAppTarget } from '../../../../shared/desktop-app-types'
import { errorMessage } from '../../../../shared/error-message'
import { isMacDesktopAppHost } from '@/lib/open-desktop-app-tab'

export type DesktopAppCaptureState = {
  stream: MediaStream | null
  error: string | null
}

// Why: main arms one window per renderer, so two panes must not interleave prepare and
// getDisplayMedia or one pane would receive the other's window.
let captureQueue: Promise<void> = Promise.resolve()

function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const run = captureQueue.then(task, task)
  captureQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** Live video of one native window while the pane is visible; stopped when hidden or switched. */
export function useDesktopAppCapture(
  target: DesktopAppTarget | null,
  isActive: boolean
): DesktopAppCaptureState {
  const [state, setState] = useState<DesktopAppCaptureState>({ stream: null, error: null })
  const windowId = target?.windowId ?? null
  const pid = target?.pid ?? null

  useEffect(() => {
    const api = window.api?.desktopApp
    // Why: the previous window's stopped stream and error must not show (or size clicks) for the next.
    setState({ stream: null, error: null })
    if (!isActive || windowId === null || pid === null || !api) {
      return
    }
    let cancelled = false
    let prepared = false
    let stream: MediaStream | null = null
    // Why: main keeps the window input-authorized until the pane that prepared it lets go.
    const release = (): void => {
      void api.releaseCapture({ windowId, pid }).catch(() => undefined)
    }
    const onTrackEnded = (): void => {
      if (!cancelled) {
        setState({
          stream: null,
          error: translate(
            'auto.components.desktop.app.pane.use.desktop.app.capture.006a3c21a6',
            'The window was closed or can no longer be captured.'
          )
        })
      }
    }
    const start = async (): Promise<void> => {
      try {
        // Main arms this window as the answer to our next getDisplayMedia; no system picker shows.
        const next = await runSerialized(async () => {
          if (cancelled) {
            return null
          }
          await api.prepareCapture({ windowId, pid })
          prepared = true
          if (cancelled) {
            release()
            return null
          }
          return navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 30, max: 60 } },
            audio: false
          })
        })
        if (!next) {
          return
        }
        if (cancelled) {
          next.getTracks().forEach((t) => t.stop())
          return
        }
        stream = next
        next.getVideoTracks()[0]?.addEventListener('ended', onTrackEnded)
        setState({ stream: next, error: null })
      } catch (err) {
        if (!cancelled) {
          setState({ stream: null, error: describeCaptureError(err) })
        }
      }
    }
    void start()
    return () => {
      // Why: a prepare still in flight releases itself once it sees `cancelled`.
      if (prepared) {
        release()
      }
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [isActive, windowId, pid])

  return state
}

function describeCaptureError(err: unknown): string {
  // Why: Chromium reports a denied screen-capture permission as a bare "Permission denied";
  // only the Mac has a fixed settings path worth naming, elsewhere the wording stays generic.
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return isMacDesktopAppHost()
      ? translate(
          'auto.components.desktop.app.pane.use.desktop.app.capture.e7c7008edc',
          'Screen capture was blocked. Allow Orca in System Settings › Privacy & Security › Screen Recording, then reopen this tab.'
        )
      : translate(
          'auto.components.desktop.app.pane.use.desktop.app.capture.2464eff017',
          'Screen capture was blocked. Allow Orca to capture the screen in your system settings, then reopen this tab.'
        )
  }
  return errorMessage(err)
}
