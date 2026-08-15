import {
  isRuntimePathAbsolute,
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison,
  normalizeRuntimePathSeparators,
  relativePathInsideRoot,
  resolveRuntimePath
} from '../cross-platform-path'
import { parseWslUncPath } from '../wsl-paths'
import {
  isAgentScratchWorktreePath,
  type AgentScratchWorktreePathMatcher
} from '../agent-scratch-worktrees'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources,
  type WorktreeVisibilitySourceMatcher
} from './visibility-sources'
import { isLegacyRepoForExternalWorktreeVisibility } from '../external-worktree-visibility'
import { shouldShowWorktree } from '../worktree-visibility-resolution'
import type { GlobalSettings, OrcaWorkspaceLayout } from '../global-settings-types'
import type { Repo } from '../repo-types'
import type { WorktreeMeta } from './meta-types'
import type { DetectedWorktree, Worktree, WorktreeOwnership } from './types'

export {
  effectiveAgentWorktreeVisibility,
  effectiveExternalWorktreeVisibility,
  EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT,
  isLegacyRepoForExternalWorktreeVisibility
} from '../external-worktree-visibility'
export { shouldShowWorktree } from '../worktree-visibility-resolution'

export function classifyWorktreeOwnership(args: {
  repo: Repo
  worktree: Pick<Worktree, 'path' | 'isMainWorktree'>
  meta?: WorktreeMeta
  settings: Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces' | 'workspaceDirHistory'>
  knownOrcaLayouts: OrcaWorkspaceLayout[]
  agentScratchWorktreePathMatcher?: AgentScratchWorktreePathMatcher
  worktreeVisibilitySourceMatcher?: WorktreeVisibilitySourceMatcher
}): WorktreeOwnership {
  if (hasStrongOrcaMetadata(args.meta)) {
    return 'orca-managed'
  }

  // Why: sub-agent scratch worktrees (e.g. .claude/worktrees) are tool
  // plumbing, not workspaces; classify before layout heuristics (#9388).
  if (
    args.worktreeVisibilitySourceMatcher?.(args.worktree.path)?.kind === 'built-in' ||
    (args.agentScratchWorktreePathMatcher?.(args.worktree.path) ??
      isAgentScratchWorktreePath(args.repo.path, args.worktree.path))
  ) {
    return 'agent-scratch'
  }

  if (isUnderFlatOrUntrustedOrcaRoot(args.worktree.path, args.knownOrcaLayouts)) {
    return 'unknown-legacy'
  }

  if (canClassifyAsExternal(args.worktree.path, args.knownOrcaLayouts)) {
    // Why: a plain `git worktree add` can target Orca's nested workspace
    // folder. Only metadata proves Orca created it.
    return 'external'
  }

  return 'unknown-legacy'
}

export function toDetectedWorktree(args: {
  repo: Repo
  worktree: Worktree
  meta?: WorktreeMeta
  settings: Pick<
    GlobalSettings,
    'workspaceDir' | 'nestWorkspaces' | 'workspaceDirHistory' | 'worktreeVisibilityDefaults'
  >
  knownOrcaLayouts: OrcaWorkspaceLayout[]
  isLegacyRepoForVisibility?: boolean
  agentScratchWorktreePathMatcher?: AgentScratchWorktreePathMatcher
  worktreeVisibilitySourceMatcher?: WorktreeVisibilitySourceMatcher
}): DetectedWorktree {
  const sourceMatcher =
    args.worktreeVisibilitySourceMatcher ??
    createWorktreeVisibilitySourceMatcher(
      [args.repo.path],
      resolveCustomWorktreeVisibilitySources(args.repo, args.settings.worktreeVisibilityDefaults)
    )
  const visibilitySource = sourceMatcher(args.worktree.path)
  const ownership = classifyWorktreeOwnership({
    ...args,
    worktreeVisibilitySourceMatcher: sourceMatcher
  })
  const selectedCheckout = areRuntimePathsEqual(args.worktree.path, args.repo.path)
  const isLegacyRepoForVisibility =
    args.isLegacyRepoForVisibility ?? isLegacyRepoForExternalWorktreeVisibility(args.repo)
  const visible = shouldShowWorktree({
    worktree: args.worktree,
    ownership,
    repo: args.repo,
    isLegacyRepoForVisibility,
    isSelectedCheckout: selectedCheckout,
    importedExternalWorktreePaths: args.repo.importedExternalWorktreePaths,
    visibilityDefaults: args.settings.worktreeVisibilityDefaults,
    visibilitySource
  })

  return {
    ...args.worktree,
    ownership,
    selectedCheckout,
    visible,
    ...(visibilitySource ? { visibilitySource } : {})
  }
}

export function applyMetadataFallbackVisibility(detected: DetectedWorktree): DetectedWorktree {
  if (detected.ownership === 'agent-scratch' || detected.visibilitySource) {
    // Why: retain scratch policy, including explicit imports, while ordinary fallback fails open.
    return detected
  }
  return {
    ...detected,
    visible: true,
    ownership: detected.ownership === 'orca-managed' ? 'orca-managed' : 'unknown-legacy'
  }
}

export function areRuntimePathsEqual(leftPath: string, rightPath: string): boolean {
  return (
    normalizeRuntimePathForComparison(leftPath) === normalizeRuntimePathForComparison(rightPath)
  )
}

function hasStrongOrcaMetadata(meta: WorktreeMeta | undefined): boolean {
  return Boolean(
    meta?.orcaCreatedAt ||
    meta?.orcaCreationWorkspaceLayout ||
    meta?.createdAt ||
    meta?.createdWithAgent ||
    meta?.pushTarget ||
    meta?.sparseBaseRef ||
    meta?.sparsePresetId ||
    meta?.preserveBranchOnDelete
  )
}

export function matchesStrongOrcaCreatePath(
  worktreePath: string,
  knownOrcaLayouts: readonly OrcaWorkspaceLayout[],
  repo: Pick<Repo, 'path'>
): boolean {
  const repoName = getRuntimePathBasename(repo.path).replace(/\.git$/i, '')
  if (!repoName) {
    return false
  }
  for (const layout of knownOrcaLayouts) {
    if (layout.worktreeLocationMode === 'nested') {
      const relative = relativePathInsideRoot(layout.path, worktreePath)
      // Why: only a positive match should short-circuit. A mismatch must fall
      // through so a later layout for the same root can still match, instead of
      // misclassifying an Orca-managed worktree as non-Orca.
      if (relative !== null && splitNormalizedPath(relative).length === 1) {
        return true
      }
      continue
    }
    if (!layout.nestWorkspaces) {
      continue
    }
    const relative = relativePathInsideRoot(layout.path, worktreePath)
    if (relative === null) {
      continue
    }
    const segments = splitNormalizedPath(relative)
    const caseInsensitive =
      isWindowsAbsolutePathLike(layout.path) || isWindowsAbsolutePathLike(worktreePath)
    if (
      segments.length === 2 &&
      normalizePathSegment(segments[0], caseInsensitive) ===
        normalizePathSegment(repoName, caseInsensitive) &&
      segments[1].length > 0
    ) {
      return true
    }
  }
  return false
}

function isUnderFlatOrUntrustedOrcaRoot(
  worktreePath: string,
  knownOrcaLayouts: OrcaWorkspaceLayout[]
): boolean {
  for (const layout of knownOrcaLayouts) {
    const relative = relativePathInsideRoot(layout.path, worktreePath)
    if (relative === null) {
      continue
    }
    if (!layout.nestWorkspaces) {
      return true
    }
  }
  return false
}

function canClassifyAsExternal(
  worktreePath: string,
  knownOrcaLayouts: OrcaWorkspaceLayout[]
): boolean {
  if (knownOrcaLayouts.length === 0) {
    return false
  }
  for (const layout of knownOrcaLayouts) {
    const relative = relativePathInsideRoot(layout.path, worktreePath)
    if (relative === null) {
      continue
    }
    return layout.nestWorkspaces
  }
  return true
}
