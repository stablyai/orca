import { focusWorkspaceViewAnchor } from '@/lib/workspace-view-actions'
import { memo, useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import EmulatorPane from './EmulatorPane'
import { tabGroupBodyAnchorName } from '../tab-group/tab-group-body-anchor'
import { useWorkspaceViewProjection } from '../workspace-grid-view/workspace-view-projection'
import { workspaceViewAnchorId } from '@/lib/workspace-view-layout'

const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_GROUPS: readonly TabGroup[] = []

type SimulatorOverlaySlotProps = {
  tab: Tab
  groupId: string | undefined
  isActive: boolean
  onFocusOwningGroup: ((groupId: string) => void) | undefined
}

const SimulatorOverlaySlot = memo(function SimulatorOverlaySlot({
  tab,
  groupId,
  isActive,
  onFocusOwningGroup
}: SimulatorOverlaySlotProps): React.JSX.Element {
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
      className="orca-emulator-overlay-slot min-h-0 min-w-0 overflow-hidden"
      onPointerDownCapture={() => {
        if (groupId && onFocusOwningGroup) {
          onFocusOwningGroup(groupId)
        }
      }}
    >
      <EmulatorPane tab={tab} worktreeId={tab.worktreeId} isActive={isActive} />
    </div>
  )
})

const EmulatorPaneOverlayLayer = memo(function EmulatorPaneOverlayLayer({
  worktreeId,
  isWorktreeActive
}: {
  worktreeId: string
  isWorktreeActive: boolean
}): React.JSX.Element {
  const viewProjection = useWorkspaceViewProjection()
  const { unifiedTabs, groups } = useAppStore(
    useShallow((state) => ({
      unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS,
      groups: state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS
    }))
  )
  const focusGroup = useAppStore((state) => state.focusGroup)
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

  const simulatorTabs = useMemo(
    () => unifiedTabs.filter((t) => t.contentType === 'simulator'),
    [unifiedTabs]
  )

  return (
    <>
      {simulatorTabs.map((tab) => {
        const placement = viewProjection?.find((p) => p.tab.id === tab.id)
        const isActiveInGroup = groupActiveTabById[tab.groupId] === tab.id
        const isActive = Boolean(
          isWorktreeActive && (viewProjection ? placement?.visible : isActiveInGroup)
        )
        return (
          <SimulatorOverlaySlot
            key={tab.id}
            tab={tab}
            groupId={
              viewProjection
                ? placement
                  ? workspaceViewAnchorId(placement.panel.id)
                  : undefined
                : tab.groupId
            }
            isActive={isActive}
            onFocusOwningGroup={focusOwningGroup}
          />
        )
      })}
    </>
  )
})

export default EmulatorPaneOverlayLayer
