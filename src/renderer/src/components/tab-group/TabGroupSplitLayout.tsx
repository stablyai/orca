import { useMemo } from 'react'
import type { TabGroupLayoutNode } from '../../../../shared/types'
import TabGroupPanel from './TabGroupPanel'

type GroupPlacement = {
  groupId: string
  gridColumn: string
  gridRow: string
}

// Why: recursive rendering changes the React tree structure when the layout
// changes (leaf → split), which unmounts and remounts TabGroupPanels —
// destroying xterm instances and killing PTY processes. CSS Grid with a flat
// list of keyed children keeps TabGroupPanels mounted across layout changes
// because React matches them by key, not by tree position.

function maxSplitDepth(node: TabGroupLayoutNode, dir: 'horizontal' | 'vertical'): number {
  if (node.type === 'leaf') {
    return 0
  }
  if (node.direction === dir) {
    return 1 + Math.max(maxSplitDepth(node.first, dir), maxSplitDepth(node.second, dir))
  }
  return Math.max(maxSplitDepth(node.first, dir), maxSplitDepth(node.second, dir))
}

function collectPlacements(
  node: TabGroupLayoutNode,
  col: number,
  colSpan: number,
  row: number,
  rowSpan: number,
  out: GroupPlacement[]
): void {
  if (node.type === 'leaf') {
    out.push({
      groupId: node.groupId,
      gridColumn: `${col} / ${col + colSpan}`,
      gridRow: `${row} / ${row + rowSpan}`
    })
    return
  }
  if (node.direction === 'horizontal') {
    const half = colSpan / 2
    collectPlacements(node.first, col, half, row, rowSpan, out)
    collectPlacements(node.second, col + half, half, row, rowSpan, out)
  } else {
    const half = rowSpan / 2
    collectPlacements(node.first, col, colSpan, row, half, out)
    collectPlacements(node.second, col, colSpan, row + half, half, out)
  }
}

function computeGridLayout(layout: TabGroupLayoutNode): {
  columns: number
  rows: number
  placements: GroupPlacement[]
} {
  const hDepth = maxSplitDepth(layout, 'horizontal')
  const vDepth = maxSplitDepth(layout, 'vertical')
  const columns = Math.max(1, Math.pow(2, hDepth))
  const rows = Math.max(1, Math.pow(2, vDepth))
  const placements: GroupPlacement[] = []
  collectPlacements(layout, 1, columns, 1, rows, placements)
  return { columns, rows, placements }
}

type TabGroupSplitLayoutProps = {
  layout: TabGroupLayoutNode
  worktreeId: string
  focusedGroupId: string | undefined
  hasSplitGroups: boolean
  onSplitTab: (tabId: string, direction: 'left' | 'right' | 'up' | 'down') => void
}

export default function TabGroupSplitLayout({
  layout,
  worktreeId,
  focusedGroupId,
  hasSplitGroups,
  onSplitTab
}: TabGroupSplitLayoutProps): React.JSX.Element {
  const { columns, rows, placements } = useMemo(() => computeGridLayout(layout), [layout])

  return (
    <div
      className="flex-1 min-w-0 min-h-0 overflow-hidden"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`
      }}
    >
      {placements.map(({ groupId, gridColumn, gridRow }) => (
        <div
          key={groupId}
          className="flex min-w-0 min-h-0 overflow-hidden"
          style={{ gridColumn, gridRow }}
        >
          <TabGroupPanel
            groupId={groupId}
            worktreeId={worktreeId}
            isFocused={groupId === focusedGroupId}
            hasSplitGroups={hasSplitGroups}
            onSplitTab={onSplitTab}
          />
        </div>
      ))}
    </div>
  )
}
