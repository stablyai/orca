import { useCallback, useEffect, useRef } from 'react'

import { useAppStore } from '../store'
import {
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  queueBrowserFocusRequest,
  type BrowserFocusRequestDetail
} from '../components/browser-pane/browser-focus'
import {
  resolveModalReturnFocusAction,
  type ModalReturnFocusSurface
} from './modal-return-focus-action'

/**
 * Restores keyboard focus to the surface that was active before a modal opened.
 *
 * Why: Radix dialogs (QuickOpen, Cmd+J) prevent the default close-time focus
 * restoration to avoid landing on a stale trigger, but must then return focus
 * themselves — otherwise dismissing the dialog with Esc leaves the active
 * terminal/editor/browser panel unfocused. Capture happens on open because
 * Radix moves document focus into the dialog before the close fires.
 */
export function useModalReturnFocus(visible: boolean): { skipReturnFocus: () => void } {
  const capturedRef = useRef<ModalReturnFocusSurface | null>(null)
  const skipRef = useRef(false)
  const wasVisibleRef = useRef(false)
  const outerFrameRef = useRef<number | null>(null)
  const innerFrameRef = useRef<number | null>(null)

  const cancelFrames = useCallback((): void => {
    if (outerFrameRef.current !== null) {
      cancelAnimationFrame(outerFrameRef.current)
      outerFrameRef.current = null
    }
    if (innerFrameRef.current !== null) {
      cancelAnimationFrame(innerFrameRef.current)
      innerFrameRef.current = null
    }
  }, [])

  useEffect(() => cancelFrames, [cancelFrames])

  // Why: a double rAF lets the dialog finish unmounting and the destination
  // surface settle before we focus it; xterm/Monaco own real focusable inputs.
  const focusFallbackSurface = useCallback((): void => {
    cancelFrames()
    outerFrameRef.current = requestAnimationFrame(() => {
      outerFrameRef.current = null
      innerFrameRef.current = requestAnimationFrame(() => {
        innerFrameRef.current = null
        const xterm = document.querySelector('.xterm-helper-textarea') as HTMLElement | null
        if (xterm) {
          xterm.focus()
          return
        }
        const monaco = document.querySelector('.monaco-editor textarea') as HTMLElement | null
        monaco?.focus()
      })
    })
  }, [cancelFrames])

  const requestBrowserFocus = useCallback((detail: BrowserFocusRequestDetail): void => {
    queueBrowserFocusRequest(detail)
    window.dispatchEvent(new CustomEvent(ORCA_BROWSER_FOCUS_REQUEST_EVENT, { detail }))
  }, [])

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      const state = useAppStore.getState()
      const worktreeId = state.activeWorktreeId
      const tabType = state.activeTabType
      const browserPageId =
        worktreeId && tabType === 'browser'
          ? ((state.browserTabsByWorktree[worktreeId] ?? []).find(
              (workspace) => workspace.id === state.activeBrowserTabId
            )?.activePageId ?? null)
          : null
      // Why: detect address-bar vs webview now — Radix has not stolen focus yet
      // at effect time, so document.activeElement still points at the surface.
      const browserTarget =
        tabType === 'browser' &&
        document.activeElement instanceof HTMLElement &&
        document.activeElement.closest('[data-orca-browser-address-bar="true"]')
          ? 'address-bar'
          : 'webview'
      capturedRef.current = { tabType, worktreeId, browserPageId, browserTarget }
      skipRef.current = false
    }

    if (!visible && wasVisibleRef.current) {
      const action = resolveModalReturnFocusAction(skipRef.current ? null : capturedRef.current)
      capturedRef.current = null
      if (action.kind === 'browser') {
        requestBrowserFocus({ pageId: action.pageId, target: action.target })
      } else if (action.kind === 'surface') {
        focusFallbackSurface()
      }
    }

    wasVisibleRef.current = visible
  }, [visible, focusFallbackSurface, requestBrowserFocus])

  // Why: callers invoke this when the close itself moves focus (e.g. opening a
  // file focuses the editor) so we don't yank focus back to the prior surface.
  const skipReturnFocus = useCallback((): void => {
    skipRef.current = true
  }, [])

  return { skipReturnFocus }
}
