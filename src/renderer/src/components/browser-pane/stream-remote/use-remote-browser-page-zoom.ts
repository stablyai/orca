import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/use-runtime-environment-capability'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { BROWSER_PAGE_ZOOM_RUNTIME_CAPABILITY } from '../../../../../shared/browser/runtime/browser-runtime-capabilities'
import type { BrowserPageZoomDirection } from '../../../../../shared/browser/site-settings/browser-page-zoom'
import type { BrowserPageSiteDisplay } from '../../../../../shared/browser/site-settings/browser-site-display'
import type { BrowserPageFeedbackBadgeHandle } from '../assemble-chrome/feedback/browser-page-feedback-badge'
import {
  addBrowserPageZoomEventListener,
  publishBrowserPageSiteDisplay
} from '../host-guest/viewport/browser-page-zoom'
import { useBrowserPageZoomFeedback } from '../host-guest/viewport/use-browser-page-zoom-feedback'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type { BrowserPageSiteDisplaySource } from '../assemble-chrome/toolbar/browser-page-site-display-source'
import { useRemoteBrowserPageSiteDisplaySource } from './use-remote-browser-page-site-display'
import type { RemoteBrowserOperationToken } from './remote-browser-stream-tokens'
import type {
  RemoteBrowserPaneNotice,
  RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'

/** Ctrl+wheel and trackpad pinch (Ctrl+wheel in Chromium) zoom, as a local guest's wheel does; Cmd too on macOS. */
export function remoteBrowserWheelZoomDirection(
  event: Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'deltaY'>
): Exclude<BrowserPageZoomDirection, 'reset'> | null {
  if (event.altKey || event.shiftKey || event.deltaY === 0) {
    return null
  }
  if (!event.ctrlKey && !(getShortcutPlatform() === 'darwin' && event.metaKey)) {
    return null
  }
  return event.deltaY < 0 ? 'in' : 'out'
}

/** Zoom belongs to the page's site in the host's browser profile, so the host steps it and says the new level. */
export function useRemoteBrowserPageZoom({
  browserPageId,
  runtimeEnvironmentId,
  onZoomed,
  lifecycle,
  runtimeTarget,
  runtimeWorktree,
  createRemoteOperationToken,
  isCurrentRemoteOperationToken,
  setPaneNotice
}: {
  browserPageId: string
  runtimeEnvironmentId: string
  /** Frames carry the new zoom too, but a static page may not repaint before the next click. */
  onZoomed: () => void
  lifecycle: RemoteBrowserStreamLifecycle
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  runtimeWorktree: string
  createRemoteOperationToken: (remotePageId?: string | null) => RemoteBrowserOperationToken | null
  isCurrentRemoteOperationToken: (token: RemoteBrowserOperationToken) => boolean
  setPaneNotice: (notice: RemoteBrowserPaneNotice | null) => void
}): {
  /** Null on hosts without browser.zoom, whose panes keep scrolling and Orca's own zoom. */
  requestZoom: ((direction: BrowserPageZoomDirection, gesture?: 'key' | 'wheel') => void) | null
  feedbackBadgeRef: RefObject<BrowserPageFeedbackBadgeHandle | null>
  /** The ⋯ menu's Zoom and Appearance and the address field's zoom chip; null on hosts that can't report them. */
  siteDisplaySource: BrowserPageSiteDisplaySource | null
} {
  const supported = useRuntimeEnvironmentCapability(
    runtimeEnvironmentId,
    BROWSER_PAGE_ZOOM_RUNTIME_CAPABILITY
  )
  const { feedbackBadgeRef, showBrowserZoomFeedback } = useBrowserPageZoomFeedback()
  // A pinch sends wheel events faster than a round trip, so one waiting wheel step stands for the rest;
  // each key press is its own step, as in a local pane.
  const inFlightRef = useRef(false)
  const queuedRef = useRef<BrowserPageZoomDirection[]>([])

  const requestZoom = useCallback(
    function zoom(direction: BrowserPageZoomDirection, gesture: 'key' | 'wheel' = 'key'): void {
      if (inFlightRef.current) {
        if (gesture === 'key' || queuedRef.current.length === 0) {
          queuedRef.current.push(direction)
        }
        return
      }
      const target = runtimeTarget()
      const pageId = lifecycle.tokens.remotePage
      const token = pageId ? createRemoteOperationToken(pageId) : null
      if (!target || !pageId || !token) {
        queuedRef.current = []
        return
      }
      inFlightRef.current = true
      callRuntimeRpc<BrowserPageSiteDisplay | null>(
        target,
        'browser.zoom',
        { worktree: runtimeWorktree, page: pageId, direction },
        { timeoutMs: 10_000, suppressFeatureInteraction: true }
      )
        .then((display) => {
          if (isCurrentRemoteOperationToken(token) && display?.site) {
            showBrowserZoomFeedback(display.zoomLevel)
            // The address field's zoom chip and an open ⋯ menu follow it, as they do a local page's.
            publishBrowserPageSiteDisplay({ browserPageId, display })
            onZoomed()
          }
        })
        .catch((error: unknown) => {
          if (isCurrentRemoteOperationToken(token)) {
            setPaneNotice({
              kind: 'consequence',
              text: error instanceof Error ? error.message : 'Remote browser command failed.'
            })
          }
        })
        .finally(() => {
          inFlightRef.current = false
          // A pane that lost its page or stream drops the rest, or it would zoom whatever it shows next.
          const queued = isCurrentRemoteOperationToken(token)
            ? queuedRef.current.shift()
            : undefined
          if (!queued) {
            queuedRef.current = []
            return
          }
          zoom(queued)
        })
    },
    [
      browserPageId,
      createRemoteOperationToken,
      isCurrentRemoteOperationToken,
      lifecycle,
      onZoomed,
      runtimeTarget,
      runtimeWorktree,
      setPaneNotice,
      showBrowserZoomFeedback
    ]
  )

  useEffect(() => {
    if (!supported) {
      return
    }
    // Zoom chords reach Orca's window, which routes them to the page whose pane holds focus.
    return addBrowserPageZoomEventListener((command) => {
      if (command.browserPageId === browserPageId) {
        requestZoom(command.direction)
      }
    })
  }, [browserPageId, requestZoom, supported])

  const siteDisplaySource = useRemoteBrowserPageSiteDisplaySource({
    runtimeEnvironmentId,
    lifecycle,
    runtimeTarget,
    runtimeWorktree,
    onZoomed
  })
  return { requestZoom: supported ? requestZoom : null, feedbackBadgeRef, siteDisplaySource }
}
