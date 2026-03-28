import type { Worktree, WorktreeMeta } from '../../../../shared/types'

export type WorktreeDeleteState = {
  isDeleting: boolean
  error: string | null
  canForceDelete: boolean
}

export type WorktreeSlice = {
  worktreesByRepo: Record<string, Worktree[]>
  activeWorktreeId: string | null
  deleteStateByWorktreeId: Record<string, WorktreeDeleteState>
  fetchWorktrees: (repoId: string) => Promise<void>
  fetchAllWorktrees: () => Promise<void>
  createWorktree: (repoId: string, name: string, baseBranch?: string) => Promise<Worktree | null>
  removeWorktree: (
    worktreeId: string,
    force?: boolean
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  clearWorktreeDeleteState: (worktreeId: string) => void
  updateWorktreeMeta: (worktreeId: string, updates: Partial<WorktreeMeta>) => Promise<void>
  markWorktreeUnread: (worktreeId: string) => void
  bumpWorktreeActivity: (worktreeId: string) => void
  setActiveWorktree: (worktreeId: string | null) => void
  allWorktrees: () => Worktree[]
}

export function findWorktreeById(
  worktreesByRepo: Record<string, Worktree[]>,
  worktreeId: string
): Worktree | undefined {
  for (const worktrees of Object.values(worktreesByRepo)) {
    const match = worktrees.find((worktree) => worktree.id === worktreeId)
    if (match) {
      return match
    }
  }

  return undefined
}

export function applyWorktreeUpdates(
  worktreesByRepo: Record<string, Worktree[]>,
  worktreeId: string,
  updates: Partial<WorktreeMeta>
): Record<string, Worktree[]> {
  let changed = false
  const next: Record<string, Worktree[]> = {}

  for (const [repoId, worktrees] of Object.entries(worktreesByRepo)) {
    let repoChanged = false
    const nextWorktrees = worktrees.map((worktree) => {
      if (worktree.id !== worktreeId) {
        return worktree
      }

      const updatedWorktree = { ...worktree, ...updates }
      repoChanged = true
      changed = true
      return updatedWorktree
    })

    next[repoId] = repoChanged ? nextWorktrees : worktrees
  }

  return changed ? next : worktreesByRepo
}

export function getRepoIdFromWorktreeId(worktreeId: string): string {
  const sepIdx = worktreeId.indexOf('::')
  return sepIdx === -1 ? worktreeId : worktreeId.slice(0, sepIdx)
}
