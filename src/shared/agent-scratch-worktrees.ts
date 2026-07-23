import { normalizeRuntimePathForComparison } from './cross-platform-path'

/** Why: agent CLIs reserve these repo-root paths for scratch; broader matches
 *  can hide legitimate user worktrees (#9388). */
const AGENT_SCRATCH_PATH_PREFIXES: readonly (readonly string[])[] = [
  ['.claude', 'worktrees'],
  ['.gsd-workspaces']
]

export type AgentScratchWorktreePathMatcher = (worktreePath: string) => boolean

export function createAgentScratchWorktreePathMatcher(
  checkoutPaths: readonly string[]
): AgentScratchWorktreePathMatcher {
  const checkoutPathKeys = new Set(checkoutPaths.map(normalizeRuntimePathForComparison))
  return (worktreePath) => {
    const segments = normalizeRuntimePathForComparison(worktreePath).split('/')
    for (const prefix of AGENT_SCRATCH_PATH_PREFIXES) {
      for (let index = 0; index + prefix.length < segments.length; index += 1) {
        if (!prefix.every((segment, offset) => segments[index + offset] === segment)) {
          continue
        }
        const checkoutPath = segments.slice(0, index).join('/')
        // Why: splitting strips the separator from filesystem roots, but normalized checkout keys retain it.
        const checkoutPathKey = /^[a-z]:$/i.test(checkoutPath)
          ? `${checkoutPath}/`
          : checkoutPath || '/'
        if (checkoutPathKeys.has(checkoutPathKey)) {
          return true
        }
      }
    }
    return false
  }
}

export function isAgentScratchWorktreePath(repoPath: string, worktreePath: string): boolean {
  return createAgentScratchWorktreePathMatcher([repoPath])(worktreePath)
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
