import { normalizeRuntimePathForComparison, relativePathInsideRoot } from '../cross-platform-path'
import { parseWslUncPath } from '../wsl-paths'
import {
  isRuntimePathAbsoluteForRepo,
  resolveConfiguredWorktreeBasePaths,
  resolveWorkspaceLayoutPath
} from './configured-worktree-base-path'
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
import type { GlobalSettings, MCodeWorkspaceLayout } from '../global-settings-types'
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

export function buildKnownMCodeWorkspaceLayouts(
  settings: Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces' | 'workspaceDirHistory'>,
  repo?: Pick<Repo, 'path' | 'connectionId' | 'worktreeBasePath'>
): MCodeWorkspaceLayout[] {
  const layouts: MCodeWorkspaceLayout[] = []
  for (const basePath of resolveConfiguredWorktreeBasePaths(repo)) {
    layouts.push({ path: basePath, nestWorkspaces: settings.nestWorkspaces })
  }
  if (settings.workspaceDir && shouldIncludeWorkspaceLayout(repo, settings.workspaceDir)) {
    layouts.push({
      path: repo
        ? resolveWorkspaceLayoutPath(repo.path, settings.workspaceDir)
        : settings.workspaceDir,
      nestWorkspaces: settings.nestWorkspaces
    })
    appendWorkspaceLayouts(
      layouts,
      (settings.workspaceDirHistory ?? [])
        .filter((layout) => shouldIncludeWorkspaceLayout(repo, layout.path))
        .map((layout) => ({
          ...layout,
          path: repo ? resolveWorkspaceLayoutPath(repo.path, layout.path) : layout.path
        }))
    )
  }

  const wslLayouts = repo ? buildWslWorkspaceLayouts(repo.path, settings) : []
  appendWorkspaceLayouts(layouts, wslLayouts)

  const seen = new Set<string>()
  return layouts.filter((layout) => {
    const key = `${normalizeRuntimePathForComparison(layout.path)}:${layout.nestWorkspaces}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return Boolean(layout.path)
  })
}

function appendWorkspaceLayouts(
  target: MCodeWorkspaceLayout[],
  source: readonly MCodeWorkspaceLayout[]
): void {
  // Why: workspace history is persisted user data and can grow large enough
  // for `push(...source)` to exceed the JavaScript call argument limit.
  for (const layout of source) {
    target.push(layout)
  }
}

function shouldIncludeWorkspaceLayout(
  repo: Pick<Repo, 'path' | 'connectionId'> | undefined,
  layoutPath: string
): boolean {
  return !repo?.connectionId || !isRuntimePathAbsoluteForRepo(repo.path, layoutPath)
}

function buildWslWorkspaceLayouts(
  repoPath: string,
  settings: Pick<GlobalSettings, 'nestWorkspaces' | 'workspaceDirHistory'>
): MCodeWorkspaceLayout[] {
  const parsed = parseWslUncPath(repoPath)
  if (!parsed) {
    return []
  }
  const homeMatch = parsed.linuxPath.match(/^\/home\/[^/]+(?:\/|$)/)
  const linuxHome = homeMatch?.[0].replace(/\/$/, '')
  if (!linuxHome) {
    return []
  }
  const root = `//wsl.localhost/${parsed.distro}${linuxHome}/mcode/workspaces`
  const historicalModes = (settings.workspaceDirHistory ?? []).map(
    (layout) => layout.nestWorkspaces
  )
  const modes = [settings.nestWorkspaces, ...historicalModes]
  return [...new Set(modes)].map((nestWorkspaces) => ({ path: root, nestWorkspaces }))
}

export function classifyWorktreeOwnership(args: {
  repo: Repo
  worktree: Pick<Worktree, 'path' | 'isMainWorktree'>
  meta?: WorktreeMeta
  settings: Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces' | 'workspaceDirHistory'>
  knownMCodeLayouts: MCodeWorkspaceLayout[]
  agentScratchWorktreePathMatcher?: AgentScratchWorktreePathMatcher
  worktreeVisibilitySourceMatcher?: WorktreeVisibilitySourceMatcher
}): WorktreeOwnership {
  if (hasStrongMCodeMetadata(args.meta)) {
    return 'mcode-managed'
  }

  // Why: sub-agent scratch worktrees (e.g. .claude/worktrees) are tool
  // plumbing, not workspaces; classify before layout heuristics (#9388). Both
  // matchers exempt a base this project explicitly configured (#15232).
  if (
    args.worktreeVisibilitySourceMatcher?.(args.worktree.path)?.kind === 'built-in' ||
    (args.agentScratchWorktreePathMatcher?.(args.worktree.path) ??
      isAgentScratchWorktreePath(
        args.repo.path,
        args.worktree.path,
        resolveConfiguredWorktreeBasePaths(args.repo)
      ))
  ) {
    return 'agent-scratch'
  }

  if (
    resolveConfiguredWorktreeBasePaths(args.repo).some(
      (basePath) => relativePathInsideRoot(basePath, args.worktree.path) !== null
    )
  ) {
    // Why: an explicit project base is trusted even when global workspace nesting is flat.
    return 'external'
  }

  if (isUnderFlatOrUntrustedMCodeRoot(args.worktree.path, args.knownMCodeLayouts)) {
    return 'unknown-legacy'
  }

  if (canClassifyAsExternal(args.worktree.path, args.knownMCodeLayouts)) {
    // Why: a plain `git worktree add` can target MCode's nested workspace
    // folder. Only metadata proves MCode created it.
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
  knownMCodeLayouts: MCodeWorkspaceLayout[]
  isLegacyRepoForVisibility?: boolean
  agentScratchWorktreePathMatcher?: AgentScratchWorktreePathMatcher
  worktreeVisibilitySourceMatcher?: WorktreeVisibilitySourceMatcher
}): DetectedWorktree {
  const sourceMatcher =
    args.worktreeVisibilitySourceMatcher ??
    createWorktreeVisibilitySourceMatcher(
      [args.repo.path],
      resolveCustomWorktreeVisibilitySources(args.repo, args.settings.worktreeVisibilityDefaults),
      resolveConfiguredWorktreeBasePaths(args.repo)
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
    ownership: detected.ownership === 'mcode-managed' ? 'mcode-managed' : 'unknown-legacy'
  }
}

export function areRuntimePathsEqual(leftPath: string, rightPath: string): boolean {
  return (
    normalizeRuntimePathForComparison(leftPath) === normalizeRuntimePathForComparison(rightPath)
  )
}

function hasStrongMCodeMetadata(meta: WorktreeMeta | undefined): boolean {
  return Boolean(
    meta?.mcodeCreatedAt ||
    meta?.mcodeCreationWorkspaceLayout ||
    meta?.createdAt ||
    meta?.createdWithAgent ||
    meta?.pushTarget ||
    meta?.sparseBaseRef ||
    meta?.sparsePresetId ||
    meta?.preserveBranchOnDelete
  )
}

function isUnderFlatOrUntrustedMCodeRoot(
  worktreePath: string,
  knownMCodeLayouts: MCodeWorkspaceLayout[]
): boolean {
  for (const layout of knownMCodeLayouts) {
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
  knownMCodeLayouts: MCodeWorkspaceLayout[]
): boolean {
  if (knownMCodeLayouts.length === 0) {
    return false
  }
  for (const layout of knownMCodeLayouts) {
    const relative = relativePathInsideRoot(layout.path, worktreePath)
    if (relative === null) {
      continue
    }
    return layout.nestWorkspaces
  }
  return true
}
