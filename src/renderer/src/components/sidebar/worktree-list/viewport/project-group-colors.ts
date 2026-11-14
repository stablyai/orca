import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../listing/render-row'
import { normalizeRepoBadgeColor } from '../../../../../../shared/repo-badge-color'
import { getProjectGroupHeaderPaddingLeft } from '../rows/indentation'

export type ProjectGroupColor = { color: string; depth: number }

export function getProjectGroupColors(
  rows: readonly RenderRow[],
  groupBy: WorktreeGroupBy
): (ProjectGroupColor | null)[] {
  if (groupBy !== 'repo') {
    return []
  }

  const ancestors: { depth: number; color: ProjectGroupColor | null }[] = []
  let current: ProjectGroupColor | null = null
  return rows.map((row) => {
    if (row.type === 'host-header' || (row.type === 'header' && !row.repo && !row.projectGroup)) {
      ancestors.length = 0
      current = null
    } else if (row.type === 'header') {
      const depth = row.projectGroupDepth ?? 0
      while (ancestors.length > 0 && (ancestors.at(-1)?.depth ?? -1) >= depth) {
        ancestors.pop()
      }
      current = ancestors.at(-1)?.color ?? null
      if (row.projectGroup && !row.repo) {
        const color =
          'color' in row.projectGroup ? normalizeRepoBadgeColor(row.projectGroup.color) : null
        if (color) {
          current = { color, depth }
        }
        ancestors.push({ depth, color: current })
      }
    }
    return current
  })
}

export function getProjectGroupBackgroundStyle(color: ProjectGroupColor | null | undefined) {
  return color
    ? {
        backgroundColor: `color-mix(in srgb, ${color.color} 15%, var(--worktree-sidebar))`,
        left: getProjectGroupHeaderPaddingLeft(color.depth) - 6
      }
    : undefined
}
