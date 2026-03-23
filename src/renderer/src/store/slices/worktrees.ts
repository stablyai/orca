import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
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
  markWorktreeUnreadFromBell: (worktreeId: string) => void
  setActiveWorktree: (worktreeId: string | null) => void
  allWorktrees: () => Worktree[]
}

export const createWorktreeSlice: StateCreator<AppState, [], [], WorktreeSlice> = (set, get) => ({
  worktreesByRepo: {},
  activeWorktreeId: null,
  deleteStateByWorktreeId: {},

  fetchWorktrees: async (repoId) => {
    try {
      const worktrees = await window.api.worktrees.list({ repoId })
      set((s) => ({
        worktreesByRepo: { ...s.worktreesByRepo, [repoId]: worktrees }
      }))
    } catch (err) {
      console.error(`Failed to fetch worktrees for repo ${repoId}:`, err)
    }
  },

  fetchAllWorktrees: async () => {
    const { repos } = get()
    await Promise.all(repos.map((r) => get().fetchWorktrees(r.id)))
  },

  createWorktree: async (repoId, name, baseBranch) => {
    try {
      const worktree = await window.api.worktrees.create({ repoId, name, baseBranch })
      set((s) => ({
        worktreesByRepo: {
          ...s.worktreesByRepo,
          [repoId]: [...(s.worktreesByRepo[repoId] ?? []), worktree]
        }
      }))
      return worktree
    } catch (err) {
      console.error('Failed to create worktree:', err)
      return null
    }
  },

  removeWorktree: async (worktreeId, force) => {
    set((s) => ({
      deleteStateByWorktreeId: {
        ...s.deleteStateByWorktreeId,
        [worktreeId]: {
          isDeleting: true,
          error: null,
          canForceDelete: false
        }
      }
    }))

    try {
      await window.api.worktrees.remove({ worktreeId, force })
      await get().shutdownWorktreeTerminals(worktreeId)
      const tabs = get().tabsByWorktree[worktreeId] ?? []
      const tabIds = new Set(tabs.map((t) => t.id))

      set((s) => {
        const next = { ...s.worktreesByRepo }
        for (const repoId of Object.keys(next)) {
          next[repoId] = next[repoId].filter((w) => w.id !== worktreeId)
        }
        const nextTabs = { ...s.tabsByWorktree }
        delete nextTabs[worktreeId]
        const nextLayouts = { ...s.terminalLayoutsByTabId }
        const nextPtyIdsByTabId = { ...s.ptyIdsByTabId }
        for (const tabId of tabIds) {
          delete nextLayouts[tabId]
          delete nextPtyIdsByTabId[tabId]
        }
        const nextDeleteState = { ...s.deleteStateByWorktreeId }
        delete nextDeleteState[worktreeId]
        return {
          worktreesByRepo: next,
          tabsByWorktree: nextTabs,
          ptyIdsByTabId: nextPtyIdsByTabId,
          terminalLayoutsByTabId: nextLayouts,
          deleteStateByWorktreeId: nextDeleteState,
          activeWorktreeId: s.activeWorktreeId === worktreeId ? null : s.activeWorktreeId,
          activeTabId: s.activeTabId && tabIds.has(s.activeTabId) ? null : s.activeTabId
        }
      })
      return { ok: true as const }
    } catch (err) {
      console.error('Failed to remove worktree:', err)
      const error = err instanceof Error ? err.message : String(err)
      set((s) => ({
        deleteStateByWorktreeId: {
          ...s.deleteStateByWorktreeId,
          [worktreeId]: {
            isDeleting: false,
            error,
            canForceDelete: !(force ?? false)
          }
        }
      }))
      return { ok: false as const, error }
    }
  },

  clearWorktreeDeleteState: (worktreeId) => {
    set((s) => {
      if (!s.deleteStateByWorktreeId[worktreeId]) {
        return {}
      }
      const next = { ...s.deleteStateByWorktreeId }
      delete next[worktreeId]
      return { deleteStateByWorktreeId: next }
    })
  },

  updateWorktreeMeta: async (worktreeId, updates) => {
    set((s) => {
      const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, updates)
      return nextWorktrees === s.worktreesByRepo ? {} : { worktreesByRepo: nextWorktrees }
    })

    try {
      await window.api.worktrees.updateMeta({ worktreeId, updates })
    } catch (err) {
      console.error('Failed to update worktree meta:', err)
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
    }
  },

  markWorktreeUnreadFromBell: (worktreeId) => {
    const activeWorktreeId = get().activeWorktreeId
    if (activeWorktreeId === worktreeId) {
      return
    }

    let shouldPersist = false
    set((s) => {
      const worktree = findWorktreeById(s.worktreesByRepo, worktreeId)
      if (!worktree || worktree.isUnread) {
        return {}
      }
      shouldPersist = true
      return {
        worktreesByRepo: applyWorktreeUpdates(s.worktreesByRepo, worktreeId, { isUnread: true })
      }
    })

    if (!shouldPersist) {
      return
    }

    void window.api.worktrees
      .updateMeta({ worktreeId, updates: { isUnread: true } })
      .catch((err) => {
        console.error('Failed to persist unread worktree bell state:', err)
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
      })
  },

  setActiveWorktree: (worktreeId) => {
    let shouldClearUnread = false
    set((s) => {
      if (!worktreeId) {
        return { activeWorktreeId: null }
      }

      const worktree = findWorktreeById(s.worktreesByRepo, worktreeId)
      shouldClearUnread = Boolean(worktree?.isUnread)
      return {
        activeWorktreeId: worktreeId,
        worktreesByRepo: shouldClearUnread
          ? applyWorktreeUpdates(s.worktreesByRepo, worktreeId, { isUnread: false })
          : s.worktreesByRepo
      }
    })

    // Refresh GitHub data (PR + issue status) for the activated worktree
    if (worktreeId) {
      get().refreshGitHubForWorktree(worktreeId)
    }

    if (!worktreeId || !shouldClearUnread) {
      return
    }

    void window.api.worktrees
      .updateMeta({ worktreeId, updates: { isUnread: false } })
      .catch((err) => {
        console.error('Failed to clear unread state for active worktree:', err)
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
      })
  },

  allWorktrees: () => Object.values(get().worktreesByRepo).flat()
})

function findWorktreeById(
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

function applyWorktreeUpdates(
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

function getRepoIdFromWorktreeId(worktreeId: string): string {
  const sepIdx = worktreeId.indexOf('::')
  return sepIdx === -1 ? worktreeId : worktreeId.slice(0, sepIdx)
}
