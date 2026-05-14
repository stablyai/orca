import { memo, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import type { Tab, TabGroup, TerminalTab } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { tabGroupBodyAnchorName } from '../tab-group/tab-group-body-anchor'
import {
  findActivityTerminalPortal,
  type ActivityTerminalPortalTarget
} from '../activity/activity-terminal-portal'
import TerminalPane from './TerminalPane'

type TerminalOverlayAssignment = {
  groupId: string
  isActiveInGroup: boolean
}

const EMPTY_TERMINAL_TABS: readonly TerminalTab[] = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_GROUPS: readonly TabGroup[] = []
const EMPTY_ACTIVITY_PORTALS: ActivityTerminalPortalTarget[] = []

type TerminalOverlaySlotProps = {
  terminalTabId: string
  terminalGeneration: number | undefined
  worktreeId: string
  worktreePath: string
  groupId: string | undefined
  isVisible: boolean
  isActive: boolean
  activityTerminalPortal: ActivityTerminalPortalTarget | null
  onFocusOwningGroup: ((groupId: string) => void) | undefined
  consumeSuppressedPtyExit: (ptyId: string) => boolean
  closeTab: (tabId: string) => void
  leaveWorktreeIfEmpty: () => void
}

const TerminalOverlaySlot = memo(function TerminalOverlaySlot({
  terminalTabId,
  terminalGeneration,
  worktreeId,
  worktreePath,
  groupId,
  isVisible,
  isActive,
  activityTerminalPortal,
  onFocusOwningGroup,
  consumeSuppressedPtyExit,
  closeTab,
  leaveWorktreeIfEmpty
}: TerminalOverlaySlotProps): React.JSX.Element {
  const anchorName = groupId !== undefined ? tabGroupBodyAnchorName(groupId) : undefined
  const style: React.CSSProperties = useMemo(
    () =>
      anchorName
        ? {
            position: 'absolute',
            positionAnchor: anchorName,
            top: `anchor(${anchorName} top)`,
            left: `anchor(${anchorName} left)`,
            width: `anchor-size(${anchorName} width)`,
            height: `anchor-size(${anchorName} height)`,
            display: isVisible ? 'flex' : 'none',
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
    [anchorName, isVisible]
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
      cwd={worktreePath}
      isActive={isActive || activityTerminalPortal?.active === true}
      // Why: split-group changes reparent TabGroupPanel subtrees. Keeping the
      // TerminalPane mounted here preserves alt-screen TUI state while this
      // flag still lets hidden tabs throttle rendering.
      isVisible={isVisible || activityTerminalPortal !== null}
      isolatedPaneId={activityTerminalPortal?.paneId ?? null}
      onPtyExit={(ptyId) => {
        if (consumeSuppressedPtyExit(ptyId)) {
          return
        }
        closeTab(terminalTabId)
        leaveWorktreeIfEmpty()
      }}
      onCloseTab={() => {
        closeTab(terminalTabId)
        leaveWorktreeIfEmpty()
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
      style={style}
      data-terminal-overlay-tab-id={terminalTabId}
      onPointerDown={focusGroup}
      onFocusCapture={focusGroup}
    >
      {terminalPane}
    </div>
  )
})

const TerminalPaneOverlayLayer = memo(function TerminalPaneOverlayLayer({
  worktreeId,
  worktreePath,
  isWorktreeActive,
  activityTerminalPortals = EMPTY_ACTIVITY_PORTALS
}: {
  worktreeId: string
  worktreePath: string
  isWorktreeActive: boolean
  activityTerminalPortals?: ActivityTerminalPortalTarget[]
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
  const closeTab = useAppStore((state) => state.closeTab)
  const setActiveWorktree = useAppStore((state) => state.setActiveWorktree)
  const reconcileWorktreeTabModel = useAppStore((state) => state.reconcileWorktreeTabModel)

  // Why: legacy TabGroupPanel routed terminal closes through
  // commands.closeItem → leaveWorktreeIfEmpty, which deselected the worktree
  // when the last renderable tab closed and sent the user back to Landing.
  // The overlay layer calls store.closeTab directly, so replicate that
  // post-close check here; otherwise closing the last terminal leaves an
  // empty TabGroupPanel body selected.
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

  const groupActiveTabById = useMemo(() => {
    const lookup: Record<string, string | null | undefined> = {}
    for (const group of groups) {
      lookup[group.id] = group.activeTabId
    }
    return lookup
  }, [groups])

  const assignments = useMemo(() => {
    const entries = new Map<string, TerminalOverlayAssignment>()
    for (const tab of unifiedTabs) {
      if (tab.contentType !== 'terminal') {
        continue
      }
      entries.set(tab.entityId, {
        groupId: tab.groupId,
        isActiveInGroup: groupActiveTabById[tab.groupId] === tab.id
      })
    }
    return entries
  }, [groupActiveTabById, unifiedTabs])

  if (!worktreePath) {
    return null
  }

  return (
    <>
      {terminalTabs.map((terminalTab) => {
        const assignment = assignments.get(terminalTab.id)
        const isVisible = Boolean(isWorktreeActive && assignment && assignment.isActiveInGroup)
        const isActive = Boolean(isVisible && assignment && assignment.groupId === activeGroupId)
        const activityTerminalPortal = findActivityTerminalPortal(
          activityTerminalPortals,
          worktreeId,
          terminalTab.id
        )
        return (
          <TerminalOverlaySlot
            key={terminalTab.id}
            terminalTabId={terminalTab.id}
            terminalGeneration={terminalTab.generation}
            worktreeId={worktreeId}
            worktreePath={worktreePath}
            groupId={assignment?.groupId}
            isVisible={isVisible}
            isActive={isActive}
            activityTerminalPortal={activityTerminalPortal}
            onFocusOwningGroup={focusOwningGroup}
            consumeSuppressedPtyExit={consumeSuppressedPtyExit}
            closeTab={closeTab}
            leaveWorktreeIfEmpty={leaveWorktreeIfEmpty}
          />
        )
      })}
    </>
  )
})

export default TerminalPaneOverlayLayer
