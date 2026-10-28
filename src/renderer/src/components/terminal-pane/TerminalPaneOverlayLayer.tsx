import { focusWorkspaceViewAnchor } from '@/lib/workspace-view-actions'
import { memo, useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '../../store'
import {
  findActivityTerminalPortal,
  type ActivityTerminalPortalTarget
} from '../activity/activity-terminal-portal'
import { shouldMountBackgroundWorktreeTab } from '../terminal/background-terminal-worktree-mount'
import { useNativeChatToggleShortcut } from '../native-chat/use-native-chat-toggle-shortcut'
import { RetainedPaneHost } from '../tab-group/RetainedPaneHost'
import { TerminalOverlaySlot } from './TerminalOverlaySlot'
import { captureWorkspaceEmptiedReaction } from '../tab-group/workspace-emptied-reaction'
import { TerminalRestoringPlaceholder } from './TerminalRestoringPlaceholder'
import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'
import { useWorkspaceViewProjection } from '../workspace-grid-view/workspace-view-projection'
import { workspaceViewAnchorId } from '@/lib/workspace-view-layout'

type TerminalOverlayAssignment = {
  unifiedTabId: string
  groupId: string
  isActiveInGroup: boolean
}

const EMPTY_TERMINAL_TABS: readonly TerminalTab[] = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_GROUPS: readonly TabGroup[] = []
const EMPTY_ACTIVITY_PORTALS: ActivityTerminalPortalTarget[] = []

const TerminalPaneOverlayLayer = memo(function TerminalPaneOverlayLayer({
  worktreeId,
  worktreePath,
  isWorktreeActive,
  isWorktreeFocused = isWorktreeActive,
  coldParkTerminalPanes = false,
  isForceParked = false,
  shouldMeasureHiddenWorktree = false,
  activityTerminalPortals = EMPTY_ACTIVITY_PORTALS,
  backgroundMountTabIds = null,
  activationDeferredMountTabIds = null,
  ownsNativeChatToggleShortcut = true
}: {
  worktreeId: string
  worktreePath: string
  isWorktreeActive: boolean
  /** False for a visible grid view member: its terminals paint but an active pane would grab focus. */
  isWorktreeFocused?: boolean
  coldParkTerminalPanes?: boolean
  /** Retention-budget force-park keeps eviction-exempt tabs mounted. */
  isForceParked?: boolean
  shouldMeasureHiddenWorktree?: boolean
  activityTerminalPortals?: ActivityTerminalPortalTarget[]
  /** Targeted mounts connect only these terminal tabs. */
  backgroundMountTabIds?: ReadonlySet<string> | null
  /** Cold-activation deferred tabs receive immediate parked watcher coverage. */
  activationDeferredMountTabIds?: ReadonlySet<string> | null
  /** Grant global keyboard chords to one workspace even when another overlay workspace remains visible. */
  ownsNativeChatToggleShortcut?: boolean
}): React.JSX.Element | null {
  const viewProjection = useWorkspaceViewProjection()
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

  useNativeChatToggleShortcut(worktreeId, isWorktreeFocused && ownsNativeChatToggleShortcut)

  const captureEmptiedReaction = useCallback(
    () => captureWorkspaceEmptiedReaction(worktreeId),
    [worktreeId]
  )

  const focusOwningGroup = useCallback(
    (groupId: string) => {
      if (!focusWorkspaceViewAnchor(viewProjection, groupId)) {
        focusGroup(worktreeId, groupId)
      }
    },
    [focusGroup, worktreeId, viewProjection]
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
        unifiedTabId: tab.id,
        groupId: viewProjection
          ? workspaceViewAnchorId(
              viewProjection.find((p) => p.tab.id === tab.id)?.panel.id ?? tab.id
            )
          : tab.groupId,
        isActiveInGroup: viewProjection
          ? viewProjection.some((p) => p.tab.id === tab.id && p.visible)
          : groupActiveTabById[tab.groupId] === tab.id
      })
    }
    return entries
  }, [groupActiveTabById, unifiedTabs, viewProjection])

  const activeTerminalTabId = useMemo(() => {
    if (viewProjection) {
      return (
        viewProjection.find((p) => p.focused && p.tab.contentType === 'terminal')?.tab.entityId ??
        null
      )
    }
    if (!activeGroupId) {
      return null
    }
    for (const [terminalTabId, assignment] of assignments) {
      if (assignment.groupId === activeGroupId && assignment.isActiveInGroup) {
        return terminalTabId
      }
    }
    return null
  }, [activeGroupId, assignments, viewProjection])

  const parkedTerminalTabIds = useTerminalTabColdParking({
    worktreeId,
    terminalTabs,
    assignments,
    isWorktreeActive,
    activeTerminalTabId,
    coldParkTerminalPanes,
    isForceParked,
    shouldMeasureHiddenWorktree,
    activityTerminalPortals,
    activationDeferredMountTabIds
  })

  if (!worktreePath) {
    return null
  }

  return (
    <>
      {terminalTabs.map((terminalTab) => {
        const assignment = assignments.get(terminalTab.id)
        const isVisible = Boolean(isWorktreeActive && assignment?.isActiveInGroup)
        if (!shouldMountBackgroundWorktreeTab(backgroundMountTabIds, terminalTab.id)) {
          // Only startup holds remain visible here; other visible deferred tabs are admitted in this render.
          return isVisible ? (
            <RetainedPaneHost
              key={terminalTab.id}
              groupId={assignment?.groupId}
              isVisible
              onFocusOwningGroup={focusOwningGroup}
            >
              <TerminalRestoringPlaceholder />
            </RetainedPaneHost>
          ) : null
        }
        const isFocusedSplit = Boolean(
          isVisible &&
          (viewProjection
            ? viewProjection.some((p) => p.tab.entityId === terminalTab.id && p.focused)
            : assignment?.groupId === activeGroupId)
        )
        // Why split from isFocusedSplit: a grid view cell keeps its own split dimming while
        // another cell holds focus, but only the focused cell's pane may take the keyboard.
        const isActive = isFocusedSplit && isWorktreeFocused
        const activityTerminalPortal = findActivityTerminalPortal(activityTerminalPortals, {
          worktreeId,
          tabId: terminalTab.id
        })
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
            isVisible={isVisible}
            isActive={isActive}
            dimmed={!viewProjection && groups.length > 1 && isVisible && !isFocusedSplit}
            activityTerminalPortal={activityTerminalPortal}
            onFocusOwningGroup={focusOwningGroup}
            consumeSuppressedPtyExit={consumeSuppressedPtyExit}
            captureEmptiedReaction={captureEmptiedReaction}
          />
        )
      })}
    </>
  )
})

export default TerminalPaneOverlayLayer
