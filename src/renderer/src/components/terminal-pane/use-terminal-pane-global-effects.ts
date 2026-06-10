import { useEffect, useRef } from 'react'
import {
  FOCUS_TERMINAL_PANE_EVENT,
  PASTE_TERMINAL_TEXT_EVENT,
  RESET_TERMINAL_WEBGL_ATLAS_EVENT,
  TOGGLE_TERMINAL_PANE_EXPAND_EVENT,
  type FocusTerminalPaneDetail,
  type PasteTerminalTextDetail,
  type ResetTerminalWebglAtlasDetail
} from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { fitAndFocusPanes, fitPanes } from './pane-helpers'
import type { PtyTransport } from './pty-transport'
import { handleTerminalFileDrop } from './terminal-drop-handler'
import {
  flushTerminalOutput,
  requestTerminalBacklogRecovery
} from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { handleFocusTerminalPaneDetail } from './focus-terminal-pane-event'
import { surfaceStaleAgentRow } from './stale-agent-row'
import { useAppStore } from '@/store'
import { restoreScrollStateAfterLayout } from '@/lib/pane-manager/pane-scroll'
import { useTerminalScrollVisibilityMemory } from './use-terminal-scroll-visibility-memory'
import { useTerminalContainerFitSync } from './use-terminal-container-fit-sync'
import { pasteTerminalText } from './terminal-bracketed-paste'

const VISIBLE_RESUME_FLUSH_CHARS = 256 * 1024

type UseTerminalPaneGlobalEffectsArgs = {
  tabId: string
  worktreeId: string
  cwd?: string
  isActive: boolean
  isVisible: boolean
  isSyncFitEnabled: boolean
  paneCount: number
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  isActiveRef: React.RefObject<boolean>
  isVisibleRef: React.RefObject<boolean>
  toggleExpandPane: (paneId: number) => void
}

export function useTerminalPaneGlobalEffects({
  tabId,
  worktreeId,
  cwd,
  isActive,
  isVisible,
  isSyncFitEnabled,
  paneCount,
  managerRef,
  containerRef,
  paneTransportsRef,
  isActiveRef,
  isVisibleRef,
  toggleExpandPane
}: UseTerminalPaneGlobalEffectsArgs): void {
  const worktreeIdRef = useRef(worktreeId)
  worktreeIdRef.current = worktreeId
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  // Starts true so the first render with isVisible=false triggers a
  // suspendRendering(). Background worktrees that mount hidden would
  // otherwise leak WebGL contexts — openTerminal() unconditionally creates
  // one — and exhaust Chromium's ~8-context budget across worktrees.
  const wasVisibleRef = useRef(true)
  const {
    captureViewportPositions,
    withSuppressedScrollTracking,
    applyPendingFollowOutputRequests,
    scheduleFollowOutputIfNeeded
  } = useTerminalScrollVisibilityMemory({
    managerRef,
    isVisibleRef,
    visibleResumeCompleteRef: wasVisibleRef,
    paneCount
  })
  useTerminalContainerFitSync({ isVisible, isSyncFitEnabled, managerRef, containerRef })

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    isActiveRef.current = isActive
    isVisibleRef.current = isVisible
    if (isVisible) {
      // Why: WebGL resume can disturb xterm's viewport bookkeeping before the
      // post-resume fit runs. Capture numeric viewport positions first; the
      // restore path avoids content matching so duplicate agent log lines do
      // not jump to the wrong history entry.
      const viewportPositions = captureViewportPositions(!wasVisibleRef.current)
      withSuppressedScrollTracking(() => {
        // Why: hidden panes can accumulate large PTY bursts while Chromium is
        // occluded. Drain a bounded slice before fitting; the scheduler keeps
        // ordering and continues the rest asynchronously so return-to-app does
        // not beachball behind an entire backlog.
        for (const pane of manager.getPanes()) {
          requestTerminalBacklogRecovery(pane.terminal)
          flushTerminalOutput(pane.terminal, { maxChars: VISIBLE_RESUME_FLUSH_CHARS })
        }
        // Resume WebGL immediately so the terminal shows its last-known state
        // on the first painted frame. macOS context creation is ~5 ms; on
        // Windows (ANGLE → D3D11) it can be 100–500 ms but a deferred resume
        // would paint a stretched DOM-fallback flash, which is worse UX.
        manager.resumeRendering()
        // Single fit on resume. Background bytes have been pushed into xterm
        // above, so this fit only absorbs container dimension changes that
        // happened while hidden (e.g. sidebar toggle on another worktree).
        if (isActive) {
          fitAndFocusPanes(manager)
        } else {
          fitPanes(manager)
        }
        for (const pane of manager.getPanes()) {
          const position = viewportPositions.get(pane.id)
          if (position) {
            restoreScrollStateAfterLayout(pane.terminal, position)
          }
        }
        manager.resetWebglTextureAtlases()
      })
      wasVisibleRef.current = true
      applyPendingFollowOutputRequests()
      return
    } else if (wasVisibleRef.current) {
      // Why: hidden DOM/layout churn can mutate xterm's viewport before the
      // pane becomes visible again. Preserve the last visible position.
      captureViewportPositions(false)
      // Suspend WebGL when going hidden. xterm.write() continues to land in
      // the (now DOM-renderer-fallback or paused-canvas) terminal; the
      // suspend is purely a GPU resource decision.
      manager.suspendRendering()
    }
    wasVisibleRef.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, isVisible])

  useEffect(() => {
    if (!isActive || !isVisible) {
      return
    }
    const onFocus = (): void => {
      // Why: WebGL atlas corruption does not always raise context loss; window
      // focus regain is a low-cost recovery point for agent TUI glyph damage.
      managerRef.current?.resetWebglTextureAtlases()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [isActive, isVisible, managerRef])

  useEffect(() => {
    const manager = managerRef.current
    const activePane = isActive && isVisible ? manager?.getActivePane() : null
    const ptyId = activePane
      ? (paneTransportsRef.current.get(activePane.id)?.getPtyId() ?? null)
      : null
    if (!ptyId || ptyId.startsWith('remote:')) {
      return
    }
    // Why: main uses this as a scheduler hint only, so the foreground pane's
    // renderer output gets first chance at the bounded ACK reserve.
    window.api.pty.setActiveRendererPty?.(ptyId, true)
    return () => window.api.pty.setActiveRendererPty?.(ptyId, false)
  }, [isActive, isVisible, managerRef, paneTransportsRef])

  useEffect(() => {
    const onToggleExpand = (event: Event): void => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail
      if (!detail?.tabId || detail.tabId !== tabId) {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const panes = manager.getPanes()
      if (panes.length < 2) {
        return
      }
      const pane = manager.getActivePane() ?? panes[0]
      if (!pane) {
        return
      }
      toggleExpandPane(pane.id)
    }
    window.addEventListener(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, onToggleExpand)
    return () => window.removeEventListener(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, onToggleExpand)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  useEffect(() => {
    const onFocusPane = (event: Event): void => {
      const detail = (event as CustomEvent<FocusTerminalPaneDetail | undefined>).detail
      handleFocusTerminalPaneDetail(detail, {
        tabId,
        manager: managerRef.current,
        acknowledgeAgents: (paneKeys) => useAppStore.getState().acknowledgeAgents(paneKeys),
        surfaceStaleAgentRow,
        scrollToBottomIfOutputSinceLastView: scheduleFollowOutputIfNeeded
      })
    }
    window.addEventListener(FOCUS_TERMINAL_PANE_EVENT, onFocusPane)
    return () => window.removeEventListener(FOCUS_TERMINAL_PANE_EVENT, onFocusPane)
  }, [tabId, managerRef, scheduleFollowOutputIfNeeded])

  useEffect(() => {
    const onResetAtlas = (event: Event): void => {
      const detail = (event as CustomEvent<ResetTerminalWebglAtlasDetail | undefined>).detail
      if (!detail?.tabId || detail.tabId !== tabId) {
        return
      }
      // Why: WebGL atlas corruption can occur with no context-loss event while
      // a CSS-hidden surface (floating workspace) holds a live context; the
      // owning surface dispatches this when it becomes visible again.
      managerRef.current?.resetWebglTextureAtlases()
    }
    window.addEventListener(RESET_TERMINAL_WEBGL_ATLAS_EVENT, onResetAtlas)
    return () => window.removeEventListener(RESET_TERMINAL_WEBGL_ATLAS_EVENT, onResetAtlas)
  }, [tabId, managerRef])

  useEffect(() => {
    const onPasteText = (event: Event): void => {
      const detail = (event as CustomEvent<PasteTerminalTextDetail | undefined>).detail
      if (!detail?.tabId || detail.tabId !== tabId || !detail.text) {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) {
        return
      }
      pasteTerminalText(pane.terminal, detail.text)
      pane.terminal.focus()
    }
    window.addEventListener(PASTE_TERMINAL_TEXT_EVENT, onPasteText)
    return () => window.removeEventListener(PASTE_TERMINAL_TEXT_EVENT, onPasteText)
  }, [tabId, managerRef])

  // Why: dictation events are dispatched globally; gate on isActiveRef so only
  // the foreground terminal pane consumes the inserted text — otherwise text
  // would be duplicated across all mounted but inactive tabs.
  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }
    const onDictationInsert = (event: Event): void => {
      if (!isActiveRef.current) {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const detail = (
        event as CustomEvent<string | { text?: string; tabId?: string; paneId?: number }>
      ).detail
      const text = typeof detail === 'string' ? detail : detail?.text
      if (typeof detail === 'object' && detail.tabId !== tabId) {
        return
      }
      const requestedPaneId = typeof detail === 'object' ? detail.paneId : undefined
      const pane = requestedPaneId
        ? manager.getPanes().find((candidate) => candidate.id === requestedPaneId)
        : (manager.getActivePane() ?? manager.getPanes()[0])
      if (!pane) {
        return
      }
      const transport = paneTransportsRef.current.get(pane.id)
      if (!transport) {
        return
      }
      if (text) {
        transport.sendInput(text)
      }
    }
    document.addEventListener('dictation:insertText', onDictationInsert)
    return () => document.removeEventListener('dictation:insertText', onDictationInsert)
  }, [isActiveRef, managerRef, paneTransportsRef, tabId])

  // Why: visible but unfocused split-group terminals can still receive native
  // OS drops. Route tab-id-aware payloads to the dropped pane, while legacy
  // payloads without a tab id keep the old active-terminal-only behavior.
  useEffect(() => {
    if (!isActive && !isVisible) {
      return
    }
    return window.api.ui.onFileDrop((data) => {
      if (data.target !== 'terminal') {
        return
      }
      if (data.tabId) {
        if (data.tabId !== tabId) {
          return
        }
      } else if (!isActive) {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const wtId = worktreeIdRef.current
      if (!wtId) {
        return
      }
      void handleTerminalFileDrop({
        manager,
        paneTransports: paneTransportsRef.current,
        worktreeId: wtId,
        cwd: cwdRef.current,
        data
      })
    })
  }, [isActive, isVisible, managerRef, paneTransportsRef, tabId])
}
