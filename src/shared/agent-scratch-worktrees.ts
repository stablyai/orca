import { normalizeRuntimePathForComparison } from './cross-platform-path'
import {
  createWorktreeVisibilitySourceMatcher,
  type WorktreeVisibilitySourceMatcher
} from './worktree/visibility-sources'

/** Why: agent CLIs reserve these repo-root paths for scratch; broader matches
 *  can hide legitimate user worktrees (#9388). */
const AGENT_SCRATCH_PATH_PREFIXES: readonly (readonly string[])[] = [
  ['.claude', 'worktrees'],
  ['.gsd-workspaces']
]

export type AgentScratchWorktreePathMatcher = (worktreePath: string) => boolean

export function createAgentScratchWorktreeSourceMatcher(
  checkoutPaths: readonly string[],
  configuredWorktreeBasePaths: readonly string[]
): WorktreeVisibilitySourceMatcher {
  return createWorktreeVisibilitySourceMatcher(checkoutPaths, [], configuredWorktreeBasePaths)
}

export function createAgentScratchWorktreePathMatcher(
  checkoutPaths: readonly string[],
  configuredWorktreeBasePaths: readonly string[]
): AgentScratchWorktreePathMatcher {
  const classify = createAgentScratchWorktreeSourceMatcher(
    checkoutPaths,
    configuredWorktreeBasePaths
  )
  return (worktreePath) => classify(worktreePath)?.kind === 'built-in'
}

export function isAgentScratchWorktreePath(
  repoPath: string,
  worktreePath: string,
  configuredWorktreeBasePaths: readonly string[]
): boolean {
  return createAgentScratchWorktreePathMatcher(
    [repoPath],
    configuredWorktreeBasePaths
  )(worktreePath)
}

/** Why: agent CLIs also mint whole scratch *repos* under these containers; a
 *  repo registered at such a root is agent-internal, not a user project (#9388). */
const AGENT_SCRATCH_REPO_ROOT_SEGMENTS: readonly (readonly string[])[] = [
  ['.codex-tmp'],
  ['.codex', 'vendor_imports'],
  ['.claude', 'skills'],
  ...AGENT_SCRATCH_PATH_PREFIXES
]

export function isAgentScratchRepoRootPath(repoPath: string): boolean {
  const segments = normalizeRuntimePathForComparison(repoPath).split('/')
  for (const marker of AGENT_SCRATCH_REPO_ROOT_SEGMENTS) {
    // Why: match the marker anywhere above the repo root (the repo lives at or
    // under the scratch container), unlike worktree matching which anchors to a
    // registered checkout path.
    for (let index = 0; index + marker.length <= segments.length; index += 1) {
      if (marker.every((segment, offset) => segments[index + offset] === segment)) {
        return true
      }
    }
  }
  return false
}
