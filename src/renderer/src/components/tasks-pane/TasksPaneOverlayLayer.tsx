import { memo, useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { Tab, TabGroup } from '../../../../shared/types'
import TasksPane from './TasksPane'
import { tabGroupBodyAnchorName } from '../tab-group/tab-group-body-anchor'

const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_GROUPS: readonly TabGroup[] = []

type TasksOverlaySlotProps = {
  tab: Tab
  groupId: string | undefined
  isActive: boolean
  onFocusOwningGroup: ((groupId: string) => void) | undefined
}

const TasksOverlaySlot = memo(function TasksOverlaySlot({
  tab,
  groupId,
  isActive,
  onFocusOwningGroup
}: TasksOverlaySlotProps): React.JSX.Element {
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
            zIndex: isActive ? 2 : 1,
            visibility: isActive ? 'visible' : 'hidden',
            pointerEvents: isActive ? 'auto' : 'none'
          }
        : { display: 'none' },
    [anchorName, isActive]
  )

  return (
    <div
      style={style}
      className="orca-tasks-overlay-slot min-h-0 min-w-0 overflow-hidden"
      onPointerDownCapture={() => {
        if (groupId && onFocusOwningGroup) {
          onFocusOwningGroup(groupId)
        }
      }}
    >
      <TasksPane worktreeId={tab.worktreeId} isActive={isActive} />
    </div>
  )
})

const TasksPaneOverlayLayer = memo(function TasksPaneOverlayLayer({
  worktreeId,
  isWorktreeActive
}: {
  worktreeId: string
  isWorktreeActive: boolean
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

  const tasksTabs = useMemo(
    () => unifiedTabs.filter((t) => t.contentType === 'tasks'),
    [unifiedTabs]
  )

  return (
    <>
      {tasksTabs.map((tab) => {
        const isActiveInGroup = groupActiveTabById[tab.groupId] === tab.id
        const isActive = Boolean(isWorktreeActive && isActiveInGroup)
        return (
          <TasksOverlaySlot
            key={tab.id}
            tab={tab}
            groupId={tab.groupId}
            isActive={isActive}
            onFocusOwningGroup={focusOwningGroup}
          />
        )
      })}
    </>
  )
})

export default TasksPaneOverlayLayer
