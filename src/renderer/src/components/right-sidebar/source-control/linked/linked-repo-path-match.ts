import {
  isPathInsideOrEqual,
  resolveRuntimePath
} from '../../../../../../shared/cross-platform-path'

export type LinkedWorktreeCandidate = {
  id: string
  path: string
}

export type AgentWriteTarget =
  | { kind: 'own' }
  | { kind: 'registered'; worktree: LinkedWorktreeCandidate }
  | { kind: 'unregistered'; filePath: string }

/** Git Bash and MSYS spell `C:\x` as `/c/x`; map it back when the workspace uses drive paths. */
export function toDrivePathForWindowsSource(rawPath: string, sourcePath: string): string {
  const msys = /^\/([A-Za-z])(\/.*)?$/.exec(rawPath)
  return msys && /^[A-Za-z]:[\\/]/.test(sourcePath)
    ? `${msys[1].toUpperCase()}:${msys[2] ?? '/'}`
    : rawPath
}

function pathDepth(path: string): number {
  return path.split(/[\\/]+/).filter(Boolean).length
}

/** Where an agent write landed relative to its own workspace and the worktrees Orca knows. */
export function classifyAgentWritePath(
  rawPath: string,
  candidates: readonly LinkedWorktreeCandidate[],
  source: LinkedWorktreeCandidate
): AgentWriteTarget {
  // Relative paths come from the agent's cwd, which is its own workspace.
  const filePath = resolveRuntimePath(
    source.path,
    toDrivePathForWindowsSource(rawPath, source.path)
  )
  const best = findWorktreeContainingPath(filePath, candidates)
  // The source wins over any shallower container, e.g. a folder workspace inside a repo.
  const insideSource =
    best?.id === source.id ||
    (source.path !== '' &&
      isPathInsideOrEqual(source.path, filePath) &&
      (!best || pathDepth(source.path) >= pathDepth(best.path)))
  if (insideSource) {
    return { kind: 'own' }
  }
  return best ? { kind: 'registered', worktree: best } : { kind: 'unregistered', filePath }
}

/** The deepest candidate containing `path`; nested repos win over their parents. */
export function findWorktreeContainingPath(
  path: string,
  candidates: readonly LinkedWorktreeCandidate[]
): LinkedWorktreeCandidate | null {
  let best: LinkedWorktreeCandidate | null = null
  for (const candidate of candidates) {
    if (
      candidate.path &&
      isPathInsideOrEqual(candidate.path, path) &&
      (!best || pathDepth(candidate.path) > pathDepth(best.path))
    ) {
      best = candidate
    }
  }
  return best
}
