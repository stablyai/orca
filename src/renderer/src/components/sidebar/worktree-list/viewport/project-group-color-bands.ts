import type { VirtualItem } from '@tanstack/react-virtual'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { normalizeRepoBadgeColor } from '../../../../../../shared/repo-badge-color'
import type { RenderRow } from '../listing/render-row'

export type ProjectGroupColorBand = {
  key: string
  color: string
  top: number
  height: number
}

// Nearest colored ancestor wins, so a nested group inherits its parent's section color.
function resolveGroupColor(
  groupId: string | null | undefined,
  groupsById: Map<string, ProjectGroup>
): string | null {
  const visited = new Set<string>()
  let current = groupId ? groupsById.get(groupId) : undefined
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    const color = normalizeRepoBadgeColor(current.color)
    if (color) {
      return color
    }
    current = current.parentGroupId ? groupsById.get(current.parentGroupId) : undefined
  }
  return null
}

function getRowGroupId(row: RenderRow): string | null | undefined {
  switch (row.type) {
    case 'header':
      if (row.repo) {
        return row.repo.projectGroupId
      }
      return row.projectGroup && typeof row.projectGroup.id === 'string'
        ? row.projectGroup.id
        : null
    case 'lineage-group':
      return row.rows[0]?.repo?.projectGroupId
    case 'folder-workspace':
      return row.projectGroup.id
    case 'host-header':
      return null
    default:
      return 'repo' in row ? row.repo?.projectGroupId : null
  }
}

/** Per-row section color; null outside colored project groups (Pinned, status lanes, hosts). */
export function buildRowProjectGroupColors(
  renderRows: readonly RenderRow[],
  projectGroups: readonly ProjectGroup[]
): (string | null)[] {
  const groupsById = new Map(projectGroups.map((group) => [group.id, group]))
  // Why: rows under a non-project header (Pinned) still carry a repo; they are not in the section.
  let insideProjectSection = false
  return renderRows.map((row) => {
    if (row.type === 'host-header') {
      insideProjectSection = false
      return null
    }
    if (row.type === 'header') {
      insideProjectSection = row.repo !== undefined || row.projectGroup !== undefined
    }
    return insideProjectSection ? resolveGroupColor(getRowGroupId(row), groupsById) : null
  })
}

/** Merges consecutive same-colored rendered rows into one band so row gaps stay tinted. */
export function buildProjectGroupColorBands(
  rowColors: readonly (string | null)[],
  virtualItems: readonly VirtualItem[]
): ProjectGroupColorBand[] {
  const bands: ProjectGroupColorBand[] = []
  let open: { color: string; start: number; end: number; index: number; key: string } | null = null
  const flush = (): void => {
    if (open) {
      bands.push({
        key: open.key,
        color: open.color,
        top: open.start,
        height: open.end - open.start
      })
      open = null
    }
  }
  for (const item of virtualItems) {
    const color = rowColors[item.index] ?? null
    if (open && color === open.color && item.index === open.index + 1) {
      open.end = item.end
      open.index = item.index
      continue
    }
    flush()
    if (color) {
      open = {
        color,
        start: item.start,
        end: item.end,
        index: item.index,
        key: `band:${item.index}`
      }
    }
  }
  flush()
  return bands
}

export function getProjectGroupTint(color: string, percent = 10): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`
}
