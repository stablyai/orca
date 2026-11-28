import { normalizeRuntimePathForComparison } from '../../file-access/cross-platform-path'
import {
  createWorktreeVisibilitySourceMatcher,
  hasBuiltInWorktreeVisibilityCandidate,
  type WorktreeVisibilitySourceMatcher
} from './visibility-sources'

/** Restrict agent scratch matches to reserved repo-root paths; broader matches hide user worktrees (#9388). */
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
  if (!hasBuiltInWorktreeVisibilityCandidate(normalizeRuntimePathForComparison(worktreePath))) {
    return false
  }
  return createAgentScratchWorktreePathMatcher(
    [repoPath],
    configuredWorktreeBasePaths
  )(worktreePath)
}

/** Agent-created repos under these reserved containers are internal rather than user projects (#9388). */
const AGENT_SCRATCH_REPO_ROOT_SEGMENTS: readonly (readonly string[])[] = [
  ['.codex-tmp'],
  ['.codex', 'vendor_imports'],
  ['.claude', 'skills'],
  ...AGENT_SCRATCH_PATH_PREFIXES
]

const AGENT_SCRATCH_REPO_ROOT_NEEDLES: readonly string[] = AGENT_SCRATCH_REPO_ROOT_SEGMENTS.map(
  (marker) => marker.join('/')
)

export function isAgentScratchRepoRootPath(repoPath: string): boolean {
  const normalized = normalizeRuntimePathForComparison(repoPath)
  let hasCandidate = false
  for (let i = 0; i < AGENT_SCRATCH_REPO_ROOT_NEEDLES.length; i += 1) {
    if (normalized.includes(AGENT_SCRATCH_REPO_ROOT_NEEDLES[i])) {
      hasCandidate = true
      break
    }
  }
  if (!hasCandidate) {
    return false
  }
  const segments = normalized.split('/')
  for (let m = 0; m < AGENT_SCRATCH_REPO_ROOT_SEGMENTS.length; m += 1) {
    if (!normalized.includes(AGENT_SCRATCH_REPO_ROOT_NEEDLES[m])) {
      continue
    }
    const marker = AGENT_SCRATCH_REPO_ROOT_SEGMENTS[m]
    // Repo scratch containers may occur anywhere above the root; worktree matches instead anchor to a registered checkout.
    for (let index = 0; index + marker.length <= segments.length; index += 1) {
      let matched = true
      for (let offset = 0; offset < marker.length; offset += 1) {
        if (segments[index + offset] !== marker[offset]) {
          matched = false
          break
        }
      }
      if (matched) {
        return true
      }
    }
  }
  return false
}
