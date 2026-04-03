import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  findWorktreeById,
  applyWorktreeUpdates,
  getRepoIdFromWorktreeId,
  type WorktreeSlice
} from './worktree-helpers'
export type { WorktreeSlice, WorktreeDeleteState } from './worktree-helpers'

export const createWorktreeSlice: StateCreator<AppState, [], [], WorktreeSlice> = (set, get) => ({
  worktreesByRepo: {},
  activeWorktreeId: null,
  deleteStateByWorktreeId: {},
  sortEpoch: 0,

  fetchWorktrees: async (repoId) => {
    try {
      const worktrees = await window.api.worktrees.list({ repoId })
      set((s) => ({
        worktreesByRepo: { ...s.worktreesByRepo, [repoId]: worktrees },
        sortEpoch: s.sortEpoch + 1
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
        },
        sortEpoch: s.sortEpoch + 1
      }))
      return worktree
    } catch (err) {
      console.error('Failed to create worktree:', err)
      throw err
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
        // Clean up editor files belonging to this worktree
        const newOpenFiles = s.openFiles.filter((f) => f.worktreeId !== worktreeId)
        const nextActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }
        delete nextActiveFileIdByWorktree[worktreeId]
        const nextActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
        delete nextActiveTabTypeByWorktree[worktreeId]
        // If the active file belonged to the removed worktree, clear it
        const activeFileCleared = s.activeFileId
          ? s.openFiles.some((f) => f.id === s.activeFileId && f.worktreeId === worktreeId)
          : false
        return {
          worktreesByRepo: next,
          tabsByWorktree: nextTabs,
          ptyIdsByTabId: nextPtyIdsByTabId,
          terminalLayoutsByTabId: nextLayouts,
          deleteStateByWorktreeId: nextDeleteState,
          activeWorktreeId: s.activeWorktreeId === worktreeId ? null : s.activeWorktreeId,
          activeTabId: s.activeTabId && tabIds.has(s.activeTabId) ? null : s.activeTabId,
          openFiles: newOpenFiles,
          activeFileIdByWorktree: nextActiveFileIdByWorktree,
          activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
          activeFileId: activeFileCleared ? null : s.activeFileId,
          activeTabType: activeFileCleared ? 'terminal' : s.activeTabType,
          sortEpoch: s.sortEpoch + 1
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
      return nextWorktrees === s.worktreesByRepo
        ? {}
        : { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
    })

    try {
      await window.api.worktrees.updateMeta({ worktreeId, updates })
    } catch (err) {
      console.error('Failed to update worktree meta:', err)
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
    }
  },

  markWorktreeUnread: (worktreeId) => {
    const activeWorktreeId = get().activeWorktreeId
    if (activeWorktreeId === worktreeId) {
      return
    }

    let shouldPersist = false
    const now = Date.now()
    set((s) => {
      const worktree = findWorktreeById(s.worktreesByRepo, worktreeId)
      if (!worktree || worktree.isUnread) {
        return {}
      }
      shouldPersist = true
      return {
        worktreesByRepo: applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
          isUnread: true,
          lastActivityAt: now
        }),
        sortEpoch: s.sortEpoch + 1
      }
    })

    if (!shouldPersist) {
      return
    }

    void window.api.worktrees
      .updateMeta({ worktreeId, updates: { isUnread: true, lastActivityAt: now } })
      .catch((err) => {
        console.error('Failed to persist unread worktree state:', err)
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
      })
  },

  bumpWorktreeActivity: (worktreeId) => {
    const now = Date.now()
    set((s) => {
      const worktree = findWorktreeById(s.worktreesByRepo, worktreeId)
      if (!worktree) {
        return {}
      }
      // Skip sortEpoch bump for the active worktree. Terminal events
      // (PTY spawn, PTY exit) in the active worktree are side-effects of
      // the user clicking the card or interacting with the terminal —
      // re-sorting the sidebar in response would cause the exact reorder-
      // on-click bug PR #209 intended to fix (e.g. dead-PTY reconnection
      // after generation bump triggers updateTabPtyId → here).
      // The lastActivityAt timestamp is still persisted so that the NEXT
      // meaningful sortEpoch bump (from a background worktree event) will
      // include this worktree's updated score.
      const isActive = s.activeWorktreeId === worktreeId
      return {
        worktreesByRepo: applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
          lastActivityAt: now
        }),
        ...(isActive ? {} : { sortEpoch: s.sortEpoch + 1 })
      }
    })

    void window.api.worktrees
      .updateMeta({ worktreeId, updates: { lastActivityAt: now } })
      .catch((err) => {
        console.error('Failed to persist worktree activity timestamp:', err)
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

      // Restore per-worktree editor state
      const restoredFileId = s.activeFileIdByWorktree[worktreeId] ?? null
      const restoredTabType = s.activeTabTypeByWorktree[worktreeId] ?? 'terminal'
      // Verify the restored file still exists in openFiles
      const fileStillOpen = restoredFileId
        ? s.openFiles.some((f) => f.id === restoredFileId)
        : false

      // If restored file is gone, fall back to another open file for this worktree
      let activeFileId: string | null
      let activeTabType: 'terminal' | 'editor'
      if (fileStillOpen) {
        activeFileId = restoredFileId
        activeTabType = restoredTabType
      } else {
        const fallbackFile = s.openFiles.find((f) => f.worktreeId === worktreeId)
        activeFileId = fallbackFile?.id ?? null
        activeTabType = fallbackFile ? 'editor' : 'terminal'
      }

      return {
        activeWorktreeId: worktreeId,
        activeFileId,
        activeTabType,
        worktreesByRepo: applyWorktreeUpdates(
          s.worktreesByRepo,
          worktreeId,
          shouldClearUnread ? { isUnread: false } : {}
        )
      }
    })

    // If the worktree has tabs but all PTYs are dead (e.g. after shutdown),
    // bump generation so TerminalPanes remount with fresh PTY connections.
    if (worktreeId) {
      const tabs = get().tabsByWorktree[worktreeId] ?? []
      const allDead = tabs.length > 0 && tabs.every((tab) => !tab.ptyId)
      if (allDead) {
        set((s) => ({
          tabsByWorktree: {
            ...s.tabsByWorktree,
            [worktreeId]: (s.tabsByWorktree[worktreeId] ?? []).map((tab) => ({
              ...tab,
              generation: (tab.generation ?? 0) + 1
            }))
          }
        }))
      }
    }

    // Refresh GitHub data (PR + issue status) on every explicit worktree selection.
    // Re-selecting the active worktree is a user-driven refresh path for stale PR state.
    if (worktreeId) {
      get().refreshGitHubForWorktree(worktreeId)
    }

    if (!worktreeId || !findWorktreeById(get().worktreesByRepo, worktreeId)) {
      return
    }

    const updates: Parameters<typeof window.api.worktrees.updateMeta>[0]['updates'] = {}
    if (shouldClearUnread) {
      updates.isUnread = false
    }

    if (Object.keys(updates).length === 0) {
      return
    }

    void window.api.worktrees.updateMeta({ worktreeId, updates }).catch((err) => {
      console.error('Failed to persist worktree activation state:', err)
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
    })
  },

  allWorktrees: () => Object.values(get().worktreesByRepo).flat()
})
