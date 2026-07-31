import type { DetectedWorktree, DetectedWorktreeListResult, Repo } from '../../../../shared/types'
import {
  areExternalWorktreeInboxPathsEqual,
  getHiddenImportableExternalWorktrees
} from '../../../../shared/external-worktree-inbox'
import { isAgentScratchWorktreePath } from '../../../../shared/agent-scratch-worktrees'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import {
  effectiveAgentWorktreeVisibility,
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility,
  shouldShowWorktree
} from '../../../../shared/worktree-ownership'

export type NonOrcaWorktreeRow = Pick<DetectedWorktree, 'id' | 'displayName' | 'path'> & {
  /** Repo-relative when the worktree sits inside the checkout, else the absolute path. */
  displayPath: string
  visible: boolean
}

export type NonOrcaWorktreeVisibilitySummary = {
  total: number
  shownCount: number
  allShown: boolean
  hiddenPaths: string[]
  shownPaths: string[]
}

export function summarizeNonOrcaWorktreeRows(
  rows: readonly NonOrcaWorktreeRow[]
): NonOrcaWorktreeVisibilitySummary {
  const shownPaths = rows.filter((row) => row.visible).map((row) => row.path)
  const hiddenPaths = rows.filter((row) => !row.visible).map((row) => row.path)
  return {
    total: rows.length,
    shownCount: shownPaths.length,
    allShown: rows.length > 0 && hiddenPaths.length === 0,
    hiddenPaths,
    shownPaths
  }
}

function toRow(worktree: DetectedWorktree, repoPath: string): NonOrcaWorktreeRow {
  const relativePath = relativePathInsideRoot(repoPath, worktree.path)
  return {
    id: worktree.id,
    displayName: worktree.displayName,
    path: worktree.path,
    displayPath: relativePath ? relativePath : worktree.path,
    visible: worktree.visible
  }
}

// Why: asks the real question, "would this row be hidden without its import", instead
// of trusting the path list, which cannot tell an exception from a switch (credit #11275).
export function isVisibleOnlyByExplicitImport(worktree: DetectedWorktree, repo: Repo): boolean {
  if (!worktree.visible || worktree.selectedCheckout) {
    return false
  }
  return !shouldShowWorktree({
    worktree,
    ownership: worktree.ownership,
    repo,
    isLegacyRepoForVisibility: isLegacyRepoForExternalWorktreeVisibility(repo),
    isSelectedCheckout: false,
    importedExternalWorktreePaths: undefined
  })
}

function agentScratchWorktrees(
  detected: DetectedWorktreeListResult | undefined
): DetectedWorktree[] {
  if (detected?.authoritative !== true) {
    return []
  }
  return detected.worktrees.filter(
    (worktree) => worktree.ownership === 'agent-scratch' && !worktree.selectedCheckout
  )
}

// Why: every agent scratch worktree, whatever its visibility, so the section can
// report a mixed state and undo the imports it lists.
export function summarizeAgentWorktreeVisibility(
  detected: DetectedWorktreeListResult | undefined,
  repo: Pick<Repo, 'path'>
): NonOrcaWorktreeVisibilitySummary {
  return summarizeNonOrcaWorktreeRows(
    agentScratchWorktrees(detected).map((worktree) => toRow(worktree, repo.path))
  )
}

// Why: a legacy repo keeps unknown-legacy rows visible whatever the setting, so this
// switch has no lever over them, exactly like orca-managed and the selected checkout.
function isGovernedByOtherWorktreeSwitch(
  worktree: DetectedWorktree,
  isLegacyRepoForVisibility: boolean
): boolean {
  if (worktree.selectedCheckout) {
    return false
  }
  if (worktree.ownership === 'orca-managed' || worktree.ownership === 'agent-scratch') {
    return false
  }
  return !(worktree.ownership === 'unknown-legacy' && isLegacyRepoForVisibility)
}

function otherWorktrees(
  detected: DetectedWorktreeListResult | undefined,
  repo: Repo
): DetectedWorktree[] {
  if (detected?.authoritative !== true) {
    return []
  }
  const isLegacy = isLegacyRepoForExternalWorktreeVisibility(repo)
  return detected.worktrees.filter((worktree) =>
    isGovernedByOtherWorktreeSwitch(worktree, isLegacy)
  )
}

// Why: the other kind needs the same derived state as scratch, or a section can claim
// "None in this repo." while listing rows that exceptions keep visible.
export function summarizeOtherWorktreeVisibility(
  detected: DetectedWorktreeListResult | undefined,
  repo: Repo
): NonOrcaWorktreeVisibilitySummary {
  return summarizeNonOrcaWorktreeRows(
    otherWorktrees(detected, repo).map((worktree) => toRow(worktree, repo.path))
  )
}

// Why: both kinds hide their per-worktree list once their own switch shows
// everything, because a row-level hide could not then hide anything.
export function buildAgentWorktreeRows(
  detected: DetectedWorktreeListResult | undefined,
  repo: Pick<Repo, 'path' | 'agentWorktreeVisibility'>
): NonOrcaWorktreeRow[] {
  if (effectiveAgentWorktreeVisibility(repo) === 'show') {
    return []
  }
  return agentScratchWorktrees(detected).map((worktree) => toRow(worktree, repo.path))
}

export function buildOtherWorktreeRows(
  detected: DetectedWorktreeListResult | undefined,
  repo: Repo
): NonOrcaWorktreeRow[] {
  if (detected?.authoritative !== true) {
    return []
  }
  if (
    effectiveExternalWorktreeVisibility(repo, isLegacyRepoForExternalWorktreeVisibility(repo)) ===
    'show'
  ) {
    return []
  }
  const hiddenIds = new Set(
    getHiddenImportableExternalWorktrees(detected)
      .filter((worktree) => worktree.ownership !== 'agent-scratch')
      .map((worktree) => worktree.id)
  )
  return otherWorktrees(detected, repo)
    .filter(
      (worktree) => hiddenIds.has(worktree.id) || isVisibleOnlyByExplicitImport(worktree, repo)
    )
    .map((worktree) => toRow(worktree, repo.path))
}

export type NonOrcaWorktreeKind = 'agent-scratch' | 'other'

// Why: ownership is decided in main with a matcher anchored at every live checkout, so
// re-deriving it here from repo.path alone misfiles scratch created inside another
// worktree. Trust the detected rows, and keep the path heuristic only for imports whose
// worktree is gone from disk.
function importedPathKind(
  importedPath: string,
  repo: Pick<Repo, 'path'>,
  detected: DetectedWorktreeListResult | undefined
): NonOrcaWorktreeKind {
  const match = detected?.worktrees.find((worktree) =>
    areExternalWorktreeInboxPathsEqual(worktree.path, importedPath)
  )
  if (match) {
    return match.ownership === 'agent-scratch' ? 'agent-scratch' : 'other'
  }
  return isAgentScratchWorktreePath(repo.path, importedPath) ? 'agent-scratch' : 'other'
}

// Why: an explicit import outranks either switch, so hiding a whole kind has to drop
// that kind's imports or the rows would stay visible against the switch just set.
export function importedPathsAfterHidingKind(
  repo: Pick<Repo, 'path' | 'importedExternalWorktreePaths'>,
  kind: NonOrcaWorktreeKind,
  detected: DetectedWorktreeListResult | undefined
): string[] {
  return (repo.importedExternalWorktreePaths ?? []).filter(
    (importedPath) => importedPathKind(importedPath, repo, detected) !== kind
  )
}

// Why: hiding a kind is a decision covering every path it governs, exceptions included
// since the flip purges them, or the inbox re-announces what the user just put away.
export function hiddenPathsForKind(
  detected: DetectedWorktreeListResult | undefined,
  kind: NonOrcaWorktreeKind,
  repo: Repo
): string[] {
  const rows =
    kind === 'agent-scratch' ? agentScratchWorktrees(detected) : otherWorktrees(detected, repo)
  return rows.map((worktree) => worktree.path)
}
