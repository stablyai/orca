import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../../store'
import { isProvenProcessExit } from '../../../../shared/terminal-exit-cause'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import {
  tabGroupBodyAnchorName,
  terminalCanvasBodyAnchorName
} from '../tab-group/tab-group-body-anchor'
import type { ActivityTerminalPortalTarget } from '../activity/activity-terminal-portal'
import TerminalPane from './TerminalPane'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { shouldDeferParkedPtyExitTabClose } from './terminal-parked-tab-watchers'

const HAS_CSS_ANCHOR_POSITIONING =
  typeof CSS !== 'undefined' &&
  CSS.supports('position-anchor', '--orca-terminal-overlay-probe') &&
  CSS.supports('top', 'anchor(--orca-terminal-overlay-probe top)') &&
  CSS.supports('width', 'anchor-size(--orca-terminal-overlay-probe width)')
const MIN_OVERLAY_FIT_WIDTH_PX = 48
const MIN_OVERLAY_FIT_HEIGHT_PX = 24
const FALLBACK_RECT_MIN_CHANGE_PX = 1

function findCanvasViewport(terminalTabId: string): HTMLElement | null {
  for (const body of document.querySelectorAll<HTMLElement>('[data-terminal-canvas-body-id]')) {
    if (body.dataset.terminalCanvasBodyId === terminalTabId) {
      return body.closest<HTMLElement>('[data-pane-canvas-viewport]')
    }
  }
  return null
}

function wheelDeltaPixels(delta: number, deltaMode: number, pageSize: number): number {
  if (deltaMode === 1) {
    return delta * 16
  }
  if (deltaMode === 2) {
    return delta * pageSize
  }
  return delta
}

function clampScroll(value: number, maximum: number): number {
  return Math.max(0, Math.min(Math.max(0, maximum), value))
}

function shouldUseCssAnchorPositioning(): boolean {
  return (
    HAS_CSS_ANCHOR_POSITIONING &&
    (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ !== true
  )
}

type MeasuredFallbackRect = {
  top: number
  left: number
  width: number
  height: number
}

type TerminalOverlaySlotProps = {
  terminalTabId: string
  terminalGeneration: number | undefined
  worktreeId: string
  worktreePath: string
  startupCwd: string | undefined
  groupId: string | undefined
  unifiedTabId?: string
  canvasTerminalTabId?: string
  /** Global Canvas cards live outside the owning worktree's containing block, so CSS anchors cannot resolve them. */
  forceMeasuredCanvasPositioning?: boolean
  isWorktreeActive: boolean
  isVisible: boolean
  isActive: boolean
  activityTerminalPortal: ActivityTerminalPortalTarget | null
  onFocusOwningGroup: ((groupId: string) => void) | undefined
  onActivateCanvasTerminal?: (terminalTabId: string, unifiedTabId: string, groupId: string) => void
  roundBottomCorners?: boolean
  consumeSuppressedPtyExit: (ptyId: string) => boolean
  leaveWorktreeIfEmpty: () => void
}

export const TerminalOverlaySlot = memo(function TerminalOverlaySlot({
  terminalTabId,
  terminalGeneration,
  worktreeId,
  worktreePath,
  startupCwd,
  groupId,
  unifiedTabId,
  canvasTerminalTabId,
  forceMeasuredCanvasPositioning = false,
  isWorktreeActive,
  isVisible,
  isActive,
  activityTerminalPortal,
  onFocusOwningGroup,
  onActivateCanvasTerminal,
  roundBottomCorners = false,
  consumeSuppressedPtyExit,
  leaveWorktreeIfEmpty
}: TerminalOverlaySlotProps): React.JSX.Element {
  const anchorName = canvasTerminalTabId
    ? terminalCanvasBodyAnchorName(canvasTerminalTabId)
    : groupId !== undefined
      ? tabGroupBodyAnchorName(groupId)
      : undefined
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const useCssAnchorPositioning = shouldUseCssAnchorPositioning() && !forceMeasuredCanvasPositioning
  const [measuredFallbackRect, setMeasuredFallbackRect] = useState<MeasuredFallbackRect | null>(
    null
  )
  const [shouldMeasureHiddenStartup, setShouldMeasureHiddenStartup] = useState(
    () => useAppStore.getState().pendingStartupByTabId[terminalTabId] !== undefined
  )
  useLayoutEffect(() => {
    if (isVisible && shouldMeasureHiddenStartup) {
      setShouldMeasureHiddenStartup(false)
    }
  }, [isVisible, shouldMeasureHiddenStartup])
  useLayoutEffect(() => {
    const anchorTargetId = canvasTerminalTabId ?? groupId
    if (!anchorName || useCssAnchorPositioning || !anchorTargetId) {
      return
    }

    const findBody = (): HTMLElement | null => {
      const selector = canvasTerminalTabId
        ? '[data-terminal-canvas-body-id]'
        : '[data-tab-group-body-id]'
      for (const candidate of document.querySelectorAll<HTMLElement>(selector)) {
        const candidateId = canvasTerminalTabId
          ? candidate.dataset.terminalCanvasBodyId
          : candidate.dataset.tabGroupBodyId
        if (candidateId === anchorTargetId) {
          return candidate
        }
      }
      return null
    }

    const body = findBody()
    if (!body) {
      setMeasuredFallbackRect(null)
      return
    }

    const updateRect = (): void => {
      const overlay = overlayRef.current
      const parent = overlay?.parentElement
      if (!parent) {
        setMeasuredFallbackRect(null)
        return
      }
      const parentRect = parent.getBoundingClientRect()
      const bodyRect = body.getBoundingClientRect()
      const next: MeasuredFallbackRect = {
        top: bodyRect.top - parentRect.top,
        left: bodyRect.left - parentRect.left,
        width: bodyRect.width,
        height: bodyRect.height
      }
      // Why: ResizeObserver and xterm fit can otherwise amplify sub-pixel jitter forever.
      setMeasuredFallbackRect((prev) =>
        prev &&
        Math.abs(prev.top - next.top) < FALLBACK_RECT_MIN_CHANGE_PX &&
        Math.abs(prev.left - next.left) < FALLBACK_RECT_MIN_CHANGE_PX &&
        Math.abs(prev.width - next.width) < FALLBACK_RECT_MIN_CHANGE_PX &&
        Math.abs(prev.height - next.height) < FALLBACK_RECT_MIN_CHANGE_PX
          ? prev
          : next
      )
    }

    updateRect()
    const parent = overlayRef.current?.parentElement
    const resizeObserver = new ResizeObserver(updateRect)
    resizeObserver.observe(body)
    if (parent) {
      resizeObserver.observe(parent)
    }
    const canvasCard = canvasTerminalTabId
      ? body.closest<HTMLElement>('[data-pane-canvas-terminal-id]')
      : null
    const cardStyleObserver = canvasCard ? new MutationObserver(updateRect) : null
    if (canvasCard && cardStyleObserver) {
      // Canvas movement changes only the card's inline left/top. ResizeObserver
      // does not see position changes, so web clients need this targeted style observer.
      cardStyleObserver.observe(canvasCard, { attributes: true, attributeFilter: ['style'] })
    }
    const canvasViewport = canvasTerminalTabId
      ? body.closest<HTMLElement>('[data-pane-canvas-viewport]')
      : null
    window.addEventListener('resize', updateRect)
    canvasViewport?.addEventListener('scroll', updateRect, { passive: true })
    return () => {
      resizeObserver.disconnect()
      cardStyleObserver?.disconnect()
      window.removeEventListener('resize', updateRect)
      canvasViewport?.removeEventListener('scroll', updateRect)
    }
  }, [anchorName, canvasTerminalTabId, groupId, isVisible, useCssAnchorPositioning])

  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay || !canvasTerminalTabId) {
      return
    }
    const containReleasedWheel = (event: WheelEvent): void => {
      // xterm consumes wheel events while its own scroll position changes, but
      // deliberately releases them at either boundary. A Canvas terminal is
      // positioned in a sibling overlay, so that released event can otherwise
      // never reach the Canvas viewport. Hand those released deltas back to the
      // viewport so users can pan in either direction without first finding a
      // sliver of empty background. React delegates wheel events through a
      // passive listener in Chromium, so this bridge must be native/non-passive.
      if (!event.defaultPrevented) {
        const viewport = findCanvasViewport(canvasTerminalTabId)
        if (viewport) {
          const nextLeft =
            viewport.scrollLeft +
            wheelDeltaPixels(event.deltaX, event.deltaMode, viewport.clientWidth)
          const nextTop =
            viewport.scrollTop +
            wheelDeltaPixels(event.deltaY, event.deltaMode, viewport.clientHeight)
          viewport.scrollLeft = clampScroll(nextLeft, viewport.scrollWidth - viewport.clientWidth)
          viewport.scrollTop = clampScroll(nextTop, viewport.scrollHeight - viewport.clientHeight)
        }
      }
      event.preventDefault()
      event.stopPropagation()
    }
    overlay.addEventListener('wheel', containReleasedWheel, { passive: false })
    return () => overlay.removeEventListener('wheel', containReleasedWheel)
  }, [canvasTerminalTabId])

  useLayoutEffect(() => {
    if (!isVisible || !anchorName) {
      return
    }
    const dispatchFitIfMeasurable = (): void => {
      const rect = overlayRef.current?.getBoundingClientRect()
      if (
        !rect ||
        rect.width < MIN_OVERLAY_FIT_WIDTH_PX ||
        rect.height < MIN_OVERLAY_FIT_HEIGHT_PX
      ) {
        return
      }
      window.dispatchEvent(new Event(SYNC_FIT_PANES_EVENT))
    }

    // Why: tab switches can resume visibility before anchor/fallback geometry
    // settles. Re-fit only after the overlay has real dimensions so the PTY
    // never stays pinned at a stale ~2-col width.
    const frameId = requestAnimationFrame(() => {
      dispatchFitIfMeasurable()
    })
    const retryId = window.setTimeout(() => {
      dispatchFitIfMeasurable()
    }, 50)
    const settledRetryId = window.setTimeout(() => {
      dispatchFitIfMeasurable()
    }, 150)
    return () => {
      cancelAnimationFrame(frameId)
      window.clearTimeout(retryId)
      window.clearTimeout(settledRetryId)
    }
  }, [anchorName, isVisible, measuredFallbackRect])

  const style: React.CSSProperties = useMemo(
    () =>
      anchorName && useCssAnchorPositioning
        ? {
            position: 'absolute',
            positionAnchor: anchorName,
            top: `anchor(${anchorName} top)`,
            left: `anchor(${anchorName} left)`,
            width: `anchor-size(${anchorName} width)`,
            height: `anchor-size(${anchorName} height)`,
            display: isVisible || shouldMeasureHiddenStartup ? 'flex' : 'none',
            opacity: isVisible ? 1 : 0,
            pointerEvents: isVisible ? 'auto' : 'none'
          }
        : anchorName
          ? {
              // Why: Chrome builds without CSS anchor positioning otherwise
              // mount the terminal into a 0x0 overlay. Measure the tab-group
              // body so the fallback does not cover the tab strip.
              position: 'absolute',
              top: measuredFallbackRect?.top ?? 32,
              left: measuredFallbackRect?.left ?? 0,
              width: measuredFallbackRect?.width ?? '100%',
              height: measuredFallbackRect?.height ?? 'calc(100% - 32px)',
              display: isVisible || shouldMeasureHiddenStartup ? 'flex' : 'none',
              opacity: isVisible ? 1 : 0,
              pointerEvents: isVisible ? 'auto' : 'none'
            }
          : {
              position: 'absolute',
              top: 0,
              left: 0,
              width: 0,
              height: 0,
              display: 'none',
              pointerEvents: 'none'
            },
    [
      anchorName,
      isVisible,
      measuredFallbackRect,
      shouldMeasureHiddenStartup,
      useCssAnchorPositioning
    ]
  )
  const focusGroup = useCallback(() => {
    if (
      canvasTerminalTabId !== undefined &&
      unifiedTabId !== undefined &&
      groupId !== undefined &&
      onActivateCanvasTerminal
    ) {
      onActivateCanvasTerminal(canvasTerminalTabId, unifiedTabId, groupId)
      return
    }
    if (groupId !== undefined && onFocusOwningGroup) {
      onFocusOwningGroup(groupId)
    }
  }, [canvasTerminalTabId, groupId, onActivateCanvasTerminal, onFocusOwningGroup, unifiedTabId])
  const focusClickedTerminal = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      focusGroup()
      const target = event.target
      const terminalRoot = target instanceof Element ? target.closest('.xterm') : null
      const terminalInput = terminalRoot?.querySelector<HTMLTextAreaElement>(
        'textarea.xterm-helper-textarea'
      )
      if (!terminalInput) {
        return
      }
      // Why: activating another Canvas group updates the overlay state during
      // the same pointer event. Reassert focus after that render so the first
      // keystroke always reaches the terminal that was clicked.
      requestAnimationFrame(() => {
        if (terminalInput.isConnected) {
          terminalInput.focus({ preventScroll: true })
        }
      })
    },
    [focusGroup]
  )
  const terminalPane = (
    <TerminalPane
      key={`${terminalTabId}-${terminalGeneration ?? 0}`}
      tabId={terminalTabId}
      worktreeId={worktreeId}
      cwd={startupCwd ?? worktreePath}
      isActive={isActive || activityTerminalPortal?.active === true}
      // Why: split-group changes reparent TabGroupPanel subtrees. Keeping the
      // TerminalPane mounted here preserves alt-screen TUI state while this
      // flag still lets hidden tabs throttle rendering.
      isVisible={isVisible || activityTerminalPortal !== null}
      isWorktreeActive={isWorktreeActive || activityTerminalPortal !== null}
      isolatedPaneKey={activityTerminalPortal?.paneKey ?? null}
      onPtyExit={(ptyId, exitCode) => {
        if (consumeSuppressedPtyExit(ptyId)) {
          return
        }
        // A synthetic host-loss exit is not evidence that the user closed the tab.
        if (exitCode !== undefined && !isProvenProcessExit(exitCode)) {
          useAppStore.getState().markUnverifiedPtyLoss(terminalTabId)
          return
        }
        // Why: a parked multi-leaf tab has no PaneManager to promote split
        // siblings, so closing the tab here would kill them; the reveal
        // remount handles dead PTYs per leaf instead.
        if (shouldDeferParkedPtyExitTabClose(terminalTabId, ptyId)) {
          return
        }
        closeTerminalTab(terminalTabId, {
          reason: 'pty-exit',
          lifecyclePtyId: ptyId,
          onClosed: leaveWorktreeIfEmpty
        })
      }}
      onCloseTab={() => {
        // Why: route through closeTerminalTab (not the raw store closeTab) so a
        // pinned tab hits the confirmation guard. The overlay's direct
        // store.closeTab was the path that closed pinned terminals silently.
        closeTerminalTab(terminalTabId, { onClosed: leaveWorktreeIfEmpty })
      }}
    />
  )

  if (activityTerminalPortal) {
    return createPortal(
      terminalPane,
      activityTerminalPortal.target,
      `activity-terminal-${terminalTabId}`
    )
  }

  return (
    <div
      ref={overlayRef}
      className={roundBottomCorners ? 'overflow-hidden rounded-b-md' : undefined}
      style={style}
      data-terminal-overlay-tab-id={terminalTabId}
      // xterm consumes pointer input inside its viewport. Capture first so a
      // Canvas card still becomes Orca's active group before xterm handles it.
      onPointerDownCapture={focusClickedTerminal}
      onFocusCapture={focusGroup}
    >
      {terminalPane}
      {/* The chat/terminal toggle now lives in the pane header's action cluster
          (TerminalPaneHeaderOverlay), beside split/close — not as a separate
          floating overlay. */}
    </div>
  )
})
