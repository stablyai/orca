import type { GitStagingArea } from '../../../../shared/git-status-types'

/**
 * Args for loading a single-file Source Control / Changes diff.
 * Unstaged (and edit Changes view) must be working-tree vs index (`git diff`),
 * not HEAD, so already-staged hunks stay under Staged Changes only.
 */
export type SourceControlDiffLoadArgs = {
  staged: boolean
  /** Always false for SC Changes / unstaged / edit-Changes — index is the left side. */
  compareAgainstHead: boolean
}

/** Map a SC status row area to `git.diff` args. Staged → index vs HEAD; else WT vs index. */
export function resolveSourceControlDiffLoadArgs(
  area: GitStagingArea | undefined
): SourceControlDiffLoadArgs {
  return {
    staged: area === 'staged',
    compareAgainstHead: false
  }
}

/**
 * Editor "Changes" view on an edit tab is the remaining working-tree delta
 * (same as SC Changes), never the mixed HEAD-vs-working-tree view.
 */
export function resolveEditChangesDiffLoadArgs(): SourceControlDiffLoadArgs {
  return {
    staged: false,
    compareAgainstHead: false
  }
}

/** openDiff's staged boolean from a SC row area (untracked opens as unstaged). */
export function isSourceControlOpenDiffStaged(area: GitStagingArea | undefined): boolean {
  return resolveSourceControlDiffLoadArgs(area).staged
}
