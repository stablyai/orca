const AGENT_MAP_LABEL_GRID_SIZE = 96
const AGENT_MAP_LABEL_MAX_CELLS_PER_BOX = 256

export type AgentMapLabelBox = {
  left: number
  right: number
  top: number
  bottom: number
}

type AgentMapLabelCells = Map<number, Map<number, AgentMapLabelBox[]>>

export type AgentMapLabelGrid = AgentMapLabelCells & {
  allBoxes?: AgentMapLabelBox[]
  largeBoxes?: AgentMapLabelBox[]
}

export function agentMapLabelBoxesOverlap(a: AgentMapLabelBox, b: AgentMapLabelBox): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

function cellRange(box: AgentMapLabelBox): {
  left: number
  right: number
  top: number
  bottom: number
  count: number
} {
  const left = Math.floor(box.left / AGENT_MAP_LABEL_GRID_SIZE)
  const right = Math.floor(box.right / AGENT_MAP_LABEL_GRID_SIZE)
  const top = Math.floor(box.top / AGENT_MAP_LABEL_GRID_SIZE)
  const bottom = Math.floor(box.bottom / AGENT_MAP_LABEL_GRID_SIZE)
  return { left, right, top, bottom, count: (right - left + 1) * (bottom - top + 1) }
}

export function addAgentMapLabelBox(grid: AgentMapLabelGrid, box: AgentMapLabelBox): void {
  if (grid.allBoxes) {
    grid.allBoxes.push(box)
  } else {
    grid.allBoxes = [box]
  }
  const range = cellRange(box)
  if (range.count > AGENT_MAP_LABEL_MAX_CELLS_PER_BOX) {
    if (grid.largeBoxes) {
      grid.largeBoxes.push(box)
    } else {
      grid.largeBoxes = [box]
    }
    return
  }
  for (let x = range.left; x <= range.right; x += 1) {
    let column = grid.get(x)
    if (!column) {
      column = new Map()
      grid.set(x, column)
    }
    for (let y = range.top; y <= range.bottom; y += 1) {
      const cell = column.get(y)
      if (cell) {
        cell.push(box)
      } else {
        column.set(y, [box])
      }
    }
  }
}

export function agentMapLabelGridCollides(grid: AgentMapLabelGrid, box: AgentMapLabelBox): boolean {
  if (grid.largeBoxes?.some((placed) => agentMapLabelBoxesOverlap(box, placed))) {
    return true
  }
  const range = cellRange(box)
  if (range.count > AGENT_MAP_LABEL_MAX_CELLS_PER_BOX) {
    return grid.allBoxes?.some((placed) => agentMapLabelBoxesOverlap(box, placed)) ?? false
  }
  for (let x = range.left; x <= range.right; x += 1) {
    const column = grid.get(x)
    if (!column) {
      continue
    }
    for (let y = range.top; y <= range.bottom; y += 1) {
      for (const placed of column.get(y) ?? []) {
        if (agentMapLabelBoxesOverlap(box, placed)) {
          return true
        }
      }
    }
  }
  return false
}
