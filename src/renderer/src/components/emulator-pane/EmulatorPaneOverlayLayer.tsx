import { memo, useCallback, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import EmulatorPane from './EmulatorPane'
import { tabGroupBodyAnchorName } from '../tab-group/tab-group-body-anchor'
import { useOverlaySlotGeometry } from '../tab-group/use-overlay-slot-geometry'

const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_GROUPS: readonly TabGroup[] = []

const HAS_CSS_ANCHOR_POSITIONING =
  typeof CSS !== 'undefined' &&
  CSS.supports('position-anchor', '--orca-emulator-overlay-probe') &&
  CSS.supports('top', 'anchor(--orca-emulator-overlay-probe top)') &&
  CSS.supports('width', 'anchor-size(--orca-emulator-overlay-probe width)')

function shouldUseCssAnchorPositioning(): boolean {
  return (
    HAS_CSS_ANCHOR_POSITIONING &&
    (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ !== true
  )
}

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
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const anchorName = groupId !== undefined ? tabGroupBodyAnchorName(groupId) : undefined
  const { measuredRect, useCssAnchors } = useOverlaySlotGeometry({
    overlayRef,
    groupId,
    worktreeId: tab.worktreeId,
    cssAnchorsSupported: shouldUseCssAnchorPositioning(),
    isVisible: isActive
  })
  const style: React.CSSProperties = useMemo(
    () =>
      anchorName && useCssAnchors
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
        : anchorName
          ? {
              position: 'absolute',
              top: measuredRect?.top ?? 32,
              left: measuredRect?.left ?? 0,
              width: measuredRect?.width ?? '100%',
              height: measuredRect?.height ?? 'calc(100% - 32px)',
              zIndex: isActive ? 2 : 1,
              visibility: isActive ? 'visible' : 'hidden',
              pointerEvents: isActive ? 'auto' : 'none'
            }
          : { display: 'none' },
    [anchorName, isActive, measuredRect, useCssAnchors]
  )

  return (
    <div
      ref={overlayRef}
      style={style}
      className="orca-emulator-overlay-slot min-h-0 min-w-0 overflow-hidden"
      data-overlay-geometry={useCssAnchors ? 'anchor' : 'measured'}
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

  const simulatorTabs = useMemo(
    () => unifiedTabs.filter((t) => t.contentType === 'simulator'),
    [unifiedTabs]
  )

  return (
    <>
      {simulatorTabs.map((tab) => {
        const isActiveInGroup = groupActiveTabById[tab.groupId] === tab.id
        const isActive = Boolean(isWorktreeActive && isActiveInGroup)
        return (
          <SimulatorOverlaySlot
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

export default EmulatorPaneOverlayLayer
