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
