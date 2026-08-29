export const AGENT_MAP_WORKTREE_GAP = 8
export const AGENT_MAP_PACKING_SCORE_TOLERANCE = 0.001

const PACKING_GRID_SIZE = 128

export type AgentMapPackableCircle = {
  id: string
  x: number
  y: number
  radius: number
}

type PackingSpatialGrid = {
  cells: Map<number, Map<number, AgentMapPackableCircle[]>>
  cellSize: number
}

export type AgentMapPackingSpatialIndex = Map<number, PackingSpatialGrid>

function packingGridLevel(radius: number): number {
  return Math.max(
    0,
    Math.ceil(Math.log2((radius * 2 + AGENT_MAP_WORKTREE_GAP) / PACKING_GRID_SIZE))
  )
}

export function addAgentMapPackingCircle(
  index: AgentMapPackingSpatialIndex,
  circle: AgentMapPackableCircle
): void {
  const level = packingGridLevel(circle.radius)
  let grid = index.get(level)
  if (!grid) {
    grid = { cells: new Map(), cellSize: PACKING_GRID_SIZE * 2 ** level }
    index.set(level, grid)
  }
  const left = Math.floor((circle.x - circle.radius) / grid.cellSize)
  const right = Math.floor((circle.x + circle.radius) / grid.cellSize)
  const top = Math.floor((circle.y - circle.radius) / grid.cellSize)
  const bottom = Math.floor((circle.y + circle.radius) / grid.cellSize)
  for (let x = left; x <= right; x += 1) {
    let column = grid.cells.get(x)
    if (!column) {
      column = new Map()
      grid.cells.set(x, column)
    }
    for (let y = top; y <= bottom; y += 1) {
      const cell = column.get(y)
      if (cell) {
        cell.push(circle)
      } else {
        column.set(y, [circle])
      }
    }
  }
}

export function agentMapPackingCircleOverlaps(
  candidate: Pick<AgentMapPackableCircle, 'x' | 'y' | 'radius'>,
  index: AgentMapPackingSpatialIndex
): boolean {
  const searchRadius = candidate.radius + AGENT_MAP_WORKTREE_GAP
  const checked = new Set<AgentMapPackableCircle>()
  for (const grid of index.values()) {
    const left = Math.floor((candidate.x - searchRadius) / grid.cellSize)
    const right = Math.floor((candidate.x + searchRadius) / grid.cellSize)
    const top = Math.floor((candidate.y - searchRadius) / grid.cellSize)
    const bottom = Math.floor((candidate.y + searchRadius) / grid.cellSize)
    for (let x = left; x <= right; x += 1) {
      const column = grid.cells.get(x)
      if (!column) {
        continue
      }
      for (let y = top; y <= bottom; y += 1) {
        for (const circle of column.get(y) ?? []) {
          if (checked.has(circle)) {
            continue
          }
          checked.add(circle)
          if (
            Math.hypot(candidate.x - circle.x, candidate.y - circle.y) <
            candidate.radius +
              circle.radius +
              AGENT_MAP_WORKTREE_GAP -
              AGENT_MAP_PACKING_SCORE_TOLERANCE
          ) {
            return true
          }
        }
      }
    }
  }
  return false
}
