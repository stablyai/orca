import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../listing/render-row'
import { normalizeRepoBadgeColor } from '../../../../../../shared/repo-badge-color'
import { getProjectGroupHeaderPaddingLeft } from '../rows/indentation'
import type { LineageRowFrame } from '../listing/lineage-row-projection'

export type ProjectGroupColor = { color: string; depth: number }

function getProjectRowParents(
  rows: readonly RenderRow[],
  groupBy: WorktreeGroupBy
): (number | null)[] {
  if (groupBy !== 'repo') {
    return []
  }

  const ancestors: { depth: number; index: number }[] = []
  let project: number | null = null
  return rows.map((row, index) => {
    if (row.type === 'host-header' || (row.type === 'header' && !row.repo && !row.projectGroup)) {
      ancestors.length = 0
      project = null
      return null
    }
    if (row.type === 'header') {
      const depth = row.projectGroupDepth ?? 0
      while (ancestors.length > 0 && (ancestors.at(-1)?.depth ?? -1) >= depth) {
        ancestors.pop()
      }
      const parent = ancestors.at(-1)?.index ?? null
      if (row.projectGroup && !row.repo) {
        ancestors.push({ depth, index })
        project = null
      } else {
        project = index
      }
      return parent
    }
    return project ?? ancestors.at(-1)?.index ?? null
  })
}

export function getProjectGroupColors(
  rows: readonly RenderRow[],
  groupBy: WorktreeGroupBy
): (ProjectGroupColor | null)[] {
  const colors: (ProjectGroupColor | null)[] = []
  getProjectRowParents(rows, groupBy).forEach((parent, index) => {
    const row = rows[index]
    const group = row.type === 'header' && !row.repo ? row.projectGroup : null
    const color = group && 'color' in group ? normalizeRepoBadgeColor(group.color) : null
    colors.push(
      color
        ? { color, depth: row.type === 'header' ? (row.projectGroupDepth ?? 0) : 0 }
        : parent === null
          ? null
          : colors[parent]
    )
  })
  return colors
}

export function getProjectGroupThreads(
  rows: readonly RenderRow[],
  groupBy: WorktreeGroupBy,
  frames: readonly Pick<LineageRowFrame, 'parent'>[]
) {
  const parents = getProjectRowParents(rows, groupBy).map((parent, index) =>
    parent === null ? null : (frames[index].parent ?? parent)
  )
  const lastChildren: (number | null)[] = parents.map(() => null)
  parents.forEach((parent, index) => {
    const row = rows[index]
    if (
      parent !== null &&
      (row.type === 'header' || row.type === 'item' || row.type === 'folder-workspace')
    ) {
      lastChildren[parent] = index
    }
  })
  return { parents, lastChildren }
}

export function getProjectGroupBackgroundStyle(color: ProjectGroupColor | null | undefined) {
  return color
    ? {
        backgroundColor: `color-mix(in srgb, ${color.color} 15%, var(--worktree-sidebar))`,
        left: getProjectGroupHeaderPaddingLeft(color.depth) - 6
      }
    : undefined
}
