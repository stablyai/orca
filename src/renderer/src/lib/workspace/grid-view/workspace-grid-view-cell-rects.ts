/** A grid view cell as percentages of the workbench, so cells follow window resizes without measuring. */
export type WorkspaceGridViewCellRect = {
  left: number
  top: number
  width: number
  height: number
}

export type WorkspaceGridViewCellEdges = {
  top: boolean
  left: boolean
  right: boolean
  bottom: boolean
}

// Why: rects are percentages that sum to 100, so float error can leave an edge cell at 99.999.
const EDGE_EPSILON = 0.001

/** Which edges of the workbench a cell touches. */
export function workspaceGridViewCellEdges(
  rect: WorkspaceGridViewCellRect
): WorkspaceGridViewCellEdges {
  return {
    top: rect.top < EDGE_EPSILON,
    left: rect.left < EDGE_EPSILON,
    right: rect.left + rect.width > 100 - EDGE_EPSILON,
    bottom: rect.top + rect.height > 100 - EDGE_EPSILON
  }
}

/** Near-square grid, filled row by row; a short last row stretches its cells across the full width. */
export function computeWorkspaceGridViewCellRects(count: number): WorkspaceGridViewCellRect[] {
  if (count <= 0) {
    return []
  }
  const columns = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / columns)
  const height = 100 / rows
  const rects: WorkspaceGridViewCellRect[] = []
  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / columns)
    const cellsInRow = row === rows - 1 ? count - row * columns : columns
    const width = 100 / cellsInRow
    rects.push({ left: (index % columns) * width, top: row * height, width, height })
  }
  return rects
}
