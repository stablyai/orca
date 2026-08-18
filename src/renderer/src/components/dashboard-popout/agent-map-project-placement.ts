import { layoutAgentMapWorktreeLineage } from './agent-map-worktree-lineage-layout'

const PROJECT_GAP = 32

type ProjectCircle = {
  id: string
  x: number
  y: number
  radius: number
  clusterParentId?: string
}

function placeUnlinkedProjects<T extends ProjectCircle>(projects: T[], aspect: number): T[] {
  if (projects.length <= 2) {
    let cursorX = 0
    return projects.map((project) => {
      const positioned = { ...project, x: cursorX + project.radius, y: 0 }
      cursorX += project.radius * 2 + PROJECT_GAP
      return positioned
    })
  }
  const radius = Math.max(...projects.map((project) => project.radius))
  const cellSize = radius * 2 + PROJECT_GAP
  const columns = Math.ceil(Math.sqrt(projects.length * aspect))
  return projects.map((project, index) => ({
    ...project,
    x: (index % columns) * cellSize + radius,
    y: Math.floor(index / columns) * cellSize + radius
  }))
}

export function placeAgentMapProjects<T extends ProjectCircle>(
  projects: T[],
  minimumWidth: number,
  minimumHeight: number,
  worldMargin: number
): { projects: T[]; width: number; height: number } {
  const positioned = projects.some((project) => project.clusterParentId)
    ? layoutAgentMapWorktreeLineage(projects)
    : placeUnlinkedProjects(projects, minimumWidth / minimumHeight)
  const left = Math.min(...positioned.map((project) => project.x - project.radius))
  const right = Math.max(...positioned.map((project) => project.x + project.radius))
  const top = Math.min(...positioned.map((project) => project.y - project.radius))
  const bottom = Math.max(...positioned.map((project) => project.y + project.radius))
  const naturalWidth = right - left + worldMargin * 2
  const naturalHeight = bottom - top + worldMargin * 2
  const width = Math.max(minimumWidth, naturalWidth)
  const height = Math.max(minimumHeight, naturalHeight)
  const offsetX = worldMargin - left + (width - naturalWidth) / 2
  const offsetY = worldMargin - top + (height - naturalHeight) / 2
  return {
    projects: positioned.map((project) => ({
      ...project,
      x: project.x + offsetX,
      y: project.y + offsetY
    })),
    width,
    height
  }
}
