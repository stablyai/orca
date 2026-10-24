import { memo, useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { Tab, TabContentType, TabGroup } from '../../../../shared/tab-types'
import { TabGroupBodyOverlaySlot } from './tab-group-body-overlay-slot'

const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_GROUPS: readonly TabGroup[] = []

/** Mounts one persistent overlay pane per tab of a live-surface type (today the emulator). */
const LiveSurfacePaneOverlayLayer = memo(function LiveSurfacePaneOverlayLayer({
  worktreeId,
  isWorktreeActive,
  contentType,
  renderPane
}: {
  worktreeId: string
  isWorktreeActive: boolean
  contentType: TabContentType
  renderPane: (tab: Tab, isActive: boolean) => React.ReactNode
}): React.JSX.Element {
  const { unifiedTabs, groups } = useAppStore(
    useShallow((state) => ({
      unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS,
      groups: state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS
    }))
  )
  const focusGroup = useAppStore((state) => state.focusGroup)
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

  const tabs = useMemo(
    () => unifiedTabs.filter((t) => t.contentType === contentType),
    [unifiedTabs, contentType]
  )

  return (
    <>
      {tabs.map((tab) => {
        const isActive = Boolean(isWorktreeActive && groupActiveTabById[tab.groupId] === tab.id)
        return (
          <TabGroupBodyOverlaySlot
            key={tab.id}
            groupId={tab.groupId}
            isActive={isActive}
            onFocusOwningGroup={focusOwningGroup}
          >
            {renderPane(tab, isActive)}
          </TabGroupBodyOverlaySlot>
        )
      })}
    </>
  )
})

export default LiveSurfacePaneOverlayLayer
