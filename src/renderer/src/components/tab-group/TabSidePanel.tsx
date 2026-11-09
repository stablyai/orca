import { useEffect, useState } from 'react'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { useAppStore } from '../../store'
import { TAB_STRIP_ORIENTATION } from '../tab-bar/tab-strip-orientation'
import {
  clampTabSidePanelWidth,
  computeMaxTabSidePanelWidth,
  TAB_SIDE_PANEL_MIN_WIDTH
} from '../../../../shared/tab-side-panel-width'

/** Vertical tab strip right of a group's body, resized from its left edge. */
export function TabSidePanel({
  groupId,
  worktreeId,
  children
}: {
  groupId: string
  worktreeId: string
  children: React.ReactNode
}): React.JSX.Element {
  const storedWidth = useAppStore((state) => state.tabSidePanelWidth)
  const setTabSidePanelWidth = useAppStore((state) => state.setTabSidePanelWidth)
  const [groupWidth, setGroupWidth] = useState<number | null>(null)
  const { containerRef, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: true,
    width: clampTabSidePanelWidth(storedWidth, groupWidth ?? undefined),
    minWidth: TAB_SIDE_PANEL_MIN_WIDTH,
    maxWidth: computeMaxTabSidePanelWidth(groupWidth ?? 0),
    deltaSign: -1,
    setWidth: setTabSidePanelWidth
  })

  useEffect(() => {
    const group = containerRef.current?.parentElement
    if (!group) {
      return
    }
    const updateGroupWidth = (): void => setGroupWidth(group.clientWidth)
    updateGroupWidth()
    const observer = new ResizeObserver(updateGroupWidth)
    observer.observe(group)
    return () => observer.disconnect()
  }, [containerRef])

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 border-l border-border bg-tab-bar"
      data-tab-side-panel=""
      data-tab-group-strip-id={groupId}
      data-tab-strip-orientation={TAB_STRIP_ORIENTATION.vertical}
      data-worktree-id={worktreeId}
    >
      {children}
      <div
        className="absolute top-0 left-0 z-30 h-full w-1 cursor-col-resize transition-colors hover:bg-ring/20 active:bg-ring/30"
        onMouseDown={onResizeStart}
      />
    </div>
  )
}
