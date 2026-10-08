import type { ProjectOrderBy } from '../../../../../shared/ui-chrome-types'

/** What the header toggle puts back when attention ordering is switched off. */
export type AttentionProjectOrderRestore = {
  projectOrderBy: Exclude<ProjectOrderBy, 'attention'>
  compactProjectRows: boolean
}

type AttentionProjectOrderState = {
  projectOrderBy: ProjectOrderBy
  compactProjectRows: boolean
  restore: AttentionProjectOrderRestore | null
}

// Why: turning attention on also folds single-workspace projects, so the scan is one row per
// project; turning it off restores both choices, or Manual when nothing was captured.
export function resolveAttentionProjectOrderToggle(
  current: AttentionProjectOrderState
): AttentionProjectOrderState {
  if (current.projectOrderBy !== 'attention') {
    return {
      projectOrderBy: 'attention',
      compactProjectRows: true,
      restore: {
        projectOrderBy: current.projectOrderBy,
        compactProjectRows: current.compactProjectRows
      }
    }
  }
  return {
    projectOrderBy: current.restore?.projectOrderBy ?? 'manual',
    compactProjectRows: current.restore?.compactProjectRows ?? current.compactProjectRows,
    restore: null
  }
}
