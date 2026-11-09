import { useCallback, useEffect, useRef } from 'react'

import { useAppStore } from '../store'
import { focusTerminalTabSurface } from '../lib/focus-terminal-tab-surface'
import {
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  queueBrowserFocusRequest,
  type BrowserFocusRequestDetail
} from '../components/browser-pane/host-guest/browser-focus'
import {
  resolveModalReturnFocusAction,
  type ModalReturnFocusSurface
} from './modal-return-focus-action'

function isRestorableFocusedElement(element: HTMLElement | null): element is HTMLElement {
  return element !== null && element !== document.body && element !== document.documentElement
}

/** Restore the pre-open surface after Radix’s default return is canceled; capture before modal focus steals document.activeElement. */
export function useModalReturnFocus(visible: boolean): {
  captureReturnFocus: () => void
  skipReturnFocus: () => void
} {
  const capturedRef = useRef<ModalReturnFocusSurface | null>(null)
  const capturedElementRef = useRef<HTMLElement | null>(null)
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

  const focusCapturedElement = useCallback((): boolean => {
    const target = capturedElementRef.current
    if (!isRestorableFocusedElement(target) || !target.isConnected) {
      return false
    }
    target.focus()
    return document.activeElement === target || target.contains(document.activeElement)
  }, [])

  const focusFirstMatchingSurface = useCallback(
    (selectors: string[]): void => {
      cancelFrames()
      outerFrameRef.current = requestAnimationFrame(() => {
        outerFrameRef.current = null
        innerFrameRef.current = requestAnimationFrame(() => {
          innerFrameRef.current = null
          for (const selector of selectors) {
            const target = document.querySelector(selector) as HTMLElement | null
            if (!target) {
              continue
            }
            target.focus()
            if (document.activeElement === target || target.contains(document.activeElement)) {
              return
            }
          }
        })
      })
    },
    [cancelFrames]
  )

  // Wait two frames for dialog unmount and destination DOM to settle before focusing.
  const focusEditorSurface = useCallback((): void => {
    if (focusCapturedElement()) {
      return
    }
    focusFirstMatchingSurface([
      '.monaco-editor textarea',
      '.rich-markdown-editor[contenteditable="true"]',
      '.markdown-preview'
    ])
  }, [focusCapturedElement, focusFirstMatchingSurface])

  const focusSimulatorSurface = useCallback((): void => {
    if (focusCapturedElement()) {
      return
    }
    focusFirstMatchingSurface(['[data-orca-emulator-frame="true"] [tabindex]'])
  }, [focusCapturedElement, focusFirstMatchingSurface])

  const focusFallbackSurface = useCallback((): void => {
    focusFirstMatchingSurface(['.xterm-helper-textarea', '.monaco-editor textarea'])
  }, [focusFirstMatchingSurface])

  const requestBrowserFocus = useCallback((detail: BrowserFocusRequestDetail): void => {
    queueBrowserFocusRequest(detail)
    window.dispatchEvent(new CustomEvent(ORCA_BROWSER_FOCUS_REQUEST_EVENT, { detail }))
  }, [])

  const captureReturnFocus = useCallback((): void => {
    const state = useAppStore.getState()
    const worktreeId = state.activeWorktreeId
    const tabType = state.activeTabType
    const activeElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const browserPageId =
      worktreeId && tabType === 'browser'
        ? ((state.browserTabsByWorktree[worktreeId] ?? []).find(
            (workspace) => workspace.id === state.activeBrowserTabId
          )?.activePageId ?? null)
        : null
    const terminalTabId =
      worktreeId && tabType === 'terminal'
        ? (state.activeTabIdByWorktree[worktreeId] ?? state.activeTabId)
        : null
    const terminalLeafId = terminalTabId
      ? (state.terminalLayoutsByTabId[terminalTabId]?.activeLeafId ?? null)
      : null
    // Capture from onOpenAutoFocus before Radix changes focus, preserving address-bar/editor/simulator identity.
    const browserTarget =
      tabType === 'browser' && activeElement?.closest('[data-orca-browser-address-bar="true"]')
        ? 'address-bar'
        : 'webview'
    capturedElementRef.current = isRestorableFocusedElement(activeElement) ? activeElement : null
    capturedRef.current = {
      tabType,
      worktreeId,
      browserPageId,
      browserTarget,
      terminalTabId,
      terminalLeafId
    }
    skipRef.current = false
  }, [])

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      cancelFrames()
      if (!capturedRef.current) {
        captureReturnFocus()
      }
      skipRef.current = false
    }

    if (!visible && wasVisibleRef.current) {
      const action = resolveModalReturnFocusAction(skipRef.current ? null : capturedRef.current)
      capturedRef.current = null
      if (action.kind === 'browser') {
        cancelFrames()
        requestBrowserFocus({ pageId: action.pageId, target: action.target })
      } else if (action.kind === 'terminal') {
        cancelFrames()
        focusTerminalTabSurface(action.tabId, action.leafId)
      } else if (action.kind === 'editor') {
        focusEditorSurface()
      } else if (action.kind === 'simulator') {
        focusSimulatorSurface()
      } else if (action.kind === 'surface') {
        focusFallbackSurface()
      }
      capturedElementRef.current = null
    }

    wasVisibleRef.current = visible
  }, [
    visible,
    cancelFrames,
    captureReturnFocus,
    focusEditorSurface,
    focusFallbackSurface,
    focusSimulatorSurface,
    requestBrowserFocus
  ])

  // Skip restoration when close already moves focus, such as opening a file.
  const skipReturnFocus = useCallback((): void => {
    skipRef.current = true
  }, [])

  return { captureReturnFocus, skipReturnFocus }
}
