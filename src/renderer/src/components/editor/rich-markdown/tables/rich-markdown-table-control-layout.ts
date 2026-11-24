export type RichMarkdownTableControlPoint = { left: number; top: number }

type ContentRect = {
  bottom: number
  left: number
  right: number
  top: number
}

type TableControlLayoutInput = {
  cell: ContentRect
  container: {
    clientHeight: number
    clientWidth: number
    scrollLeft: number
    scrollTop: number
  }
  row: ContentRect
  table: ContentRect
}

export type RichMarkdownTableControlLayout = {
  addColumn: RichMarkdownTableControlPoint
  addRow: RichMarkdownTableControlPoint
  columnMenu: RichMarkdownTableControlPoint
  rowMenu: RichMarkdownTableControlPoint
}

const CONTROL_SIZE = 24
const AXIS_CONTROL_THICKNESS = 14
const EDGE_GAP = 4

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

function center(start: number, end: number): number {
  return (start + end - CONTROL_SIZE) / 2
}

export function getRichMarkdownTableControlLayout({
  cell,
  container,
  row,
  table
}: TableControlLayoutInput): RichMarkdownTableControlLayout {
  const minimumLeft = container.scrollLeft + EDGE_GAP
  const maximumLeft = container.scrollLeft + container.clientWidth - CONTROL_SIZE - EDGE_GAP
  const minimumTop = container.scrollTop + EDGE_GAP
  const maximumTop = container.scrollTop + container.clientHeight - CONTROL_SIZE - EDGE_GAP
  const visibleLeft = (value: number): number => clamp(value, minimumLeft, maximumLeft)
  const visibleTop = (value: number): number => clamp(value, minimumTop, maximumTop)

  return {
    rowMenu: {
      left: visibleLeft(table.left - AXIS_CONTROL_THICKNESS - EDGE_GAP),
      top: visibleTop(center(row.top, row.bottom))
    },
    columnMenu: {
      left: visibleLeft(center(cell.left, cell.right)),
      top: visibleTop(table.top - AXIS_CONTROL_THICKNESS - EDGE_GAP)
    },
    addColumn: {
      left: visibleLeft(table.right + EDGE_GAP),
      top: visibleTop(table.top)
    },
    addRow: {
      left: visibleLeft(table.left),
      top: visibleTop(table.bottom + EDGE_GAP)
    }
  }
}
