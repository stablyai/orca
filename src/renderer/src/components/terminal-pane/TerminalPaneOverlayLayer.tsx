import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import type { Tab, TabGroup, TerminalTab } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { tabGroupBodyAnchorName } from '../tab-group/tab-group-body-anchor'
import {
  findActivityTerminalPortal,
  type ActivityTerminalPortalTarget
} from '../activity/activity-terminal-portal'
import TerminalPane from './TerminalPane'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { shouldMountBackgroundWorktreeTab } from '../terminal/background-terminal-worktree-mount'
import { useNativeChatToggleShortcut } from '../native-chat/use-native-chat-toggle-shortcut'
import { shouldDeferParkedPtyExitTabClose } from './terminal-parked-tab-watchers'
import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'
import { useTerminalOverlayPresentation } from './use-terminal-overlay-presentation'
import { buildTerminalOverlayAssignments } from './terminal-overlay-assignments'
import {
  FALLBACK_RECT_MIN_CHANGE_PX,
  MIN_OVERLAY_FIT_HEIGHT_PX,
  MIN_OVERLAY_FIT_WIDTH_PX,
  shouldUseCssAnchorPositioning
} from './terminal-overlay-positioning'

const EMPTY_TERMINAL_TABS: readonly TerminalTab[] = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_GROUPS: readonly TabGroup[] = []
const EMPTY_ACTIVITY_PORTALS: ActivityTerminalPortalTarget[] = []

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
  isWorktreeActive: boolean
  isWorktreePresented: boolean
  isVisible: boolean
  isPresented: boolean
  isActive: boolean
  activityTerminalPortal: ActivityTerminalPortalTarget | null
  onFocusOwningGroup: ((groupId: string) => void) | undefined
  consumeSuppressedPtyExit: (ptyId: string) => boolean
  leaveWorktreeIfEmpty: () => void
  onInitialRenderSettled?: () => void
}

export const TerminalOverlaySlot = memo(function TerminalOverlaySlot({
  terminalTabId,
  terminalGeneration,
  worktreeId,
  worktreePath,
  startupCwd,
  groupId,
  isWorktreeActive,
  isWorktreePresented,
  isVisible,
  isPresented,
  isActive,
  activityTerminalPortal,
  onFocusOwningGroup,
  consumeSuppressedPtyExit,
  leaveWorktreeIfEmpty,
  onInitialRenderSettled
}: TerminalOverlaySlotProps): React.JSX.Element {
  const anchorName = groupId !== undefined ? tabGroupBodyAnchorName(groupId) : undefined
  const overlayRef = useRef<HTMLDivElement | null>(null)
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
    if (!anchorName || shouldUseCssAnchorPositioning() || !groupId) {
      return
    }

    const findBody = (): HTMLElement | null => {
      for (const candidate of document.querySelectorAll<HTMLElement>('[data-tab-group-body-id]')) {
        if (candidate.dataset.tabGroupBodyId === groupId) {
          return candidate
        }
      }
      return null
    }

    const updateRect = (): void => {
      const overlay = overlayRef.current
      const parent = overlay?.parentElement
      const body = findBody()
      if (!parent || !body) {
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
    const body = findBody()
    const parent = overlayRef.current?.parentElement
    const resizeObserver = new ResizeObserver(updateRect)
    if (body) {
      resizeObserver.observe(body)
    }
    if (parent) {
      resizeObserver.observe(parent)
    }
    window.addEventListener('resize', updateRect)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', updateRect)
    }
  }, [anchorName, groupId, isVisible])

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

  const showPresentedTerminal = isPresented && (isWorktreeActive || isWorktreePresented)
  const isInteractive = isVisible && isPresented && isWorktreePresented
  const style: React.CSSProperties = useMemo(
    () =>
      anchorName && shouldUseCssAnchorPositioning()
        ? {
            position: 'absolute',
            positionAnchor: anchorName,
            top: `anchor(${anchorName} top)`,
            left: `anchor(${anchorName} left)`,
            width: `anchor-size(${anchorName} width)`,
            height: `anchor-size(${anchorName} height)`,
            display:
              isVisible || showPresentedTerminal || shouldMeasureHiddenStartup ? 'flex' : 'none',
            opacity: showPresentedTerminal ? 1 : 0,
            pointerEvents: isInteractive ? 'auto' : 'none'
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
              display:
                isVisible || showPresentedTerminal || shouldMeasureHiddenStartup ? 'flex' : 'none',
              opacity: showPresentedTerminal ? 1 : 0,
              pointerEvents: isInteractive ? 'auto' : 'none'
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
      isInteractive,
      isVisible,
      measuredFallbackRect,
      shouldMeasureHiddenStartup,
      showPresentedTerminal
    ]
  )
  const focusGroup = useCallback(() => {
    if (groupId !== undefined && onFocusOwningGroup) {
      onFocusOwningGroup(groupId)
    }
  }, [groupId, onFocusOwningGroup])

  const terminalPane = (
    <TerminalPane
      key={`${terminalTabId}-${terminalGeneration ?? 0}`}
      tabId={terminalTabId}
      worktreeId={worktreeId}
      cwd={startupCwd ?? worktreePath}
      isActive={
        (isActive && isPresented && isWorktreePresented) || activityTerminalPortal?.active === true
      }
      // Why: split-group changes reparent TabGroupPanel subtrees. Keeping the
      // TerminalPane mounted here preserves alt-screen TUI state while this
      // flag still lets hidden tabs throttle rendering.
      isVisible={isVisible || showPresentedTerminal || activityTerminalPortal !== null}
      isWorktreeActive={isWorktreeActive || isWorktreePresented || activityTerminalPortal !== null}
      isolatedPaneKey={activityTerminalPortal?.paneKey ?? null}
      onPtyExit={(ptyId) => {
        if (consumeSuppressedPtyExit(ptyId)) {
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
      onInitialRenderSettled={onInitialRenderSettled}
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
      style={style}
      data-terminal-overlay-tab-id={terminalTabId}
      data-terminal-overlay-presented={showPresentedTerminal ? 'true' : 'false'}
      inert={!isInteractive}
      aria-hidden={!isInteractive}
      onPointerDown={focusGroup}
      onFocusCapture={focusGroup}
    >
      {terminalPane}
      {/* The chat/terminal toggle now lives in the pane header's action cluster
          (TerminalPaneHeaderOverlay), beside split/close — not as a separate
          floating overlay. */}
    </div>
  )
})

const TerminalPaneOverlayLayer = memo(function TerminalPaneOverlayLayer({
  worktreeId,
  worktreePath,
  isWorktreeActive,
  isWorktreePresented = isWorktreeActive,
  coldParkTerminalPanes = false,
  shouldMeasureHiddenWorktree = false,
  activityTerminalPortals = EMPTY_ACTIVITY_PORTALS,
  backgroundMountTabIds = null,
  activationDeferredMountTabIds = null,
  onInitialTerminalRenderSettled
}: {
  worktreeId: string
  worktreePath: string
  isWorktreeActive: boolean
  isWorktreePresented?: boolean
  coldParkTerminalPanes?: boolean
  shouldMeasureHiddenWorktree?: boolean
  activityTerminalPortals?: ActivityTerminalPortalTarget[]
  /** Non-null for targeted background mounts: only these terminal tabs get a
   *  TerminalPane, so waking one slept agent does not connect every saved tab. */
  backgroundMountTabIds?: ReadonlySet<string> | null
  /** Only cold-activation deferred tabs receive immediate parked watcher
   *  coverage; targeted mounts keep their existing delayed parking policy. */
  activationDeferredMountTabIds?: ReadonlySet<string> | null
  onInitialTerminalRenderSettled?: (tabId: string) => void
}): React.JSX.Element | null {
  const { terminalTabs, unifiedTabs, groups, activeGroupId } = useAppStore(
    useShallow((state) => ({
      terminalTabs: state.tabsByWorktree[worktreeId] ?? EMPTY_TERMINAL_TABS,
      unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS,
      groups: state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS,
      activeGroupId: state.activeGroupIdByWorktree[worktreeId]
    }))
  )
  const focusGroup = useAppStore((state) => state.focusGroup)
  const consumeSuppressedPtyExit = useAppStore((state) => state.consumeSuppressedPtyExit)
  const setActiveWorktree = useAppStore((state) => state.setActiveWorktree)
  const reconcileWorktreeTabModel = useAppStore((state) => state.reconcileWorktreeTabModel)

  useNativeChatToggleShortcut(worktreeId, isWorktreeActive)

  // Why: legacy TabGroupPanel routed terminal closes through
  // commands.closeItem → leaveWorktreeIfEmpty, which deselected the worktree
  // when the last renderable tab closed and sent the user back to Landing.
  // Run this only after the guarded close resolves; a pending/cancelled pinned
  // close must leave the worktree and paired-web mirror selected.
  const leaveWorktreeIfEmpty = useCallback(() => {
    const state = useAppStore.getState()
    if (state.activeWorktreeId !== worktreeId) {
      return
    }
    const { renderableTabCount } = reconcileWorktreeTabModel(worktreeId)
    if (renderableTabCount === 0) {
      setActiveWorktree(null)
    }
  }, [reconcileWorktreeTabModel, setActiveWorktree, worktreeId])

  const focusOwningGroup = useCallback(
    (groupId: string) => focusGroup(worktreeId, groupId),
    [focusGroup, worktreeId]
  )

  const assignments = useMemo(
    () => buildTerminalOverlayAssignments(groups, unifiedTabs),
    [groups, unifiedTabs]
  )

  const { parkedTerminalTabIds, coldParkedTerminalTabIds } = useTerminalTabColdParking({
    worktreeId,
    terminalTabs,
    assignments,
    isWorktreeActive,
    coldParkTerminalPanes,
    shouldMeasureHiddenWorktree,
    activityTerminalPortals,
    activationDeferredMountTabIds
  })
  const { presentedTerminalTabIdByGroup: presentationByScope, handleInitialRenderSettled } =
    useTerminalOverlayPresentation({
      groups,
      terminalTabs,
      assignments,
      coldParkedTerminalTabIds,
      isWorktreeActive,
      activeGroupId,
      onInitialTerminalRenderSettled
    })

  if (!worktreePath) {
    return null
  }

  return (
    <>
      {terminalTabs
        .filter((terminalTab) =>
          shouldMountBackgroundWorktreeTab(backgroundMountTabIds, terminalTab.id)
        )
        .map((terminalTab) => {
          const assignment = assignments.get(terminalTab.id)
          const isVisible = Boolean(isWorktreeActive && assignment && assignment.isActiveInGroup)
          const isActive = Boolean(isVisible && assignment && assignment.groupId === activeGroupId)
          const isPresented = Boolean(
            assignment && presentationByScope.get(assignment.groupId) === terminalTab.id
          )
          const activityTerminalPortal = findActivityTerminalPortal(activityTerminalPortals, {
            worktreeId,
            tabId: terminalTab.id
          })
          // Why: parking unmounts only the view; the parked watcher owns exit
          // and side-effect handling until this tab is eligible to remount.
          if (parkedTerminalTabIds.has(terminalTab.id)) {
            return null
          }
          return (
            <TerminalOverlaySlot
              key={terminalTab.id}
              terminalTabId={terminalTab.id}
              terminalGeneration={terminalTab.generation}
              worktreeId={worktreeId}
              worktreePath={worktreePath}
              startupCwd={terminalTab.startupCwd}
              groupId={assignment?.groupId}
              isWorktreeActive={isWorktreeActive}
              isWorktreePresented={isWorktreePresented}
              isVisible={isVisible}
              isPresented={isPresented}
              isActive={isActive}
              activityTerminalPortal={activityTerminalPortal}
              onFocusOwningGroup={focusOwningGroup}
              consumeSuppressedPtyExit={consumeSuppressedPtyExit}
              leaveWorktreeIfEmpty={leaveWorktreeIfEmpty}
              onInitialRenderSettled={() => handleInitialRenderSettled(terminalTab.id)}
            />
          )
        })}
    </>
  )
})

export default TerminalPaneOverlayLayer
