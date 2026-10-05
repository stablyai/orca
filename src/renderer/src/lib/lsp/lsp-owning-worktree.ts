import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'

export type OwningWorktree = { worktreeId: string; worktreePath: string; repoId: string }

function normalize(path: string, platform: 'win32' | 'posix'): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' ? slashed.toLowerCase() : slashed
}

export function currentPathPlatform(): 'win32' | 'posix' {
  return navigator.userAgent.includes('Windows') ? 'win32' : 'posix'
}

export function findOwningWorktree(
  worktrees: Iterable<Pick<Worktree, 'id' | 'path' | 'repoId' | 'hostId'>>,
  filePath: string,
  platform: 'win32' | 'posix' = currentPathPlatform()
): OwningWorktree | null {
  const target = normalize(filePath, platform)
  let best: OwningWorktree | null = null
  let bestLength = -1
  for (const worktree of worktrees) {
    if (worktree.hostId && worktree.hostId !== LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    const root = normalize(worktree.path, platform)
    if ((target === root || target.startsWith(`${root}/`)) && root.length > bestLength) {
      best = { worktreeId: worktree.id, worktreePath: worktree.path, repoId: worktree.repoId }
      bestLength = root.length
    }
  }
  return best
}
