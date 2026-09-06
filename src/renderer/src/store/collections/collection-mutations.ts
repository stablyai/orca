import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Collection } from '../../../../shared/collection-types'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import type { RepoSlice } from '../repos/repo-state'

export function createCollectionMutationActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'createCollection' | 'updateCollection' | 'deleteCollection'> {
  return {
    createCollection: async (name) => {
      try {
        const target = getActiveRuntimeTarget(get().settings)
        const collection =
          target.kind === 'local'
            ? await window.api.collections.create({ name })
            : (
                await callRuntimeRpc<{ collection: Collection }>(
                  target,
                  'collection.create',
                  { name },
                  { timeoutMs: 15_000 }
                )
              ).collection
        if (!collection) {
          return null
        }
        set((s) => ({ collections: [...s.collections, collection] }))
        return collection
      } catch (err) {
        console.error('Failed to create collection:', err)
        return null
      }
    },

    updateCollection: async (collectionId, updates) => {
      try {
        const target = getActiveRuntimeTarget(get().settings)
        const updated =
          target.kind === 'local'
            ? await window.api.collections.update({ collectionId, updates })
            : (
                await callRuntimeRpc<{ collection: Collection | null }>(
                  target,
                  'collection.update',
                  { collectionId, updates },
                  { timeoutMs: 15_000 }
                )
              ).collection
        if (updated) {
          set((s) => ({
            collections: s.collections.map((collection) =>
              collection.id === collectionId ? updated : collection
            )
          }))
        }
        return updated
      } catch (err) {
        console.error('Failed to update collection:', err)
        return null
      }
    },

    deleteCollection: async (collectionId) => {
      try {
        const target = getActiveRuntimeTarget(get().settings)
        const deleted =
          target.kind === 'local'
            ? await window.api.collections.delete({ collectionId })
            : (
                await callRuntimeRpc<{ deleted: boolean }>(
                  target,
                  'collection.delete',
                  { collectionId },
                  { timeoutMs: 15_000 }
                )
              ).deleted
        if (deleted) {
          // Why: memberships were stripped server-side; mirror locally so rows
          // vanish without waiting for the next worktree refresh. Computed before
          // set() so the updater stays a pure state transform.
          const collectionGroupPrefix = `collection:${collectionId}`
          const state = get()
          const nextWorktreesByRepo = Object.fromEntries(
            Object.entries(state.worktreesByRepo).map(([repoId, worktrees]) => [
              repoId,
              worktrees.some((worktree) => worktree.collectionIds?.includes(collectionId))
                ? worktrees.map((worktree) =>
                    worktree.collectionIds?.includes(collectionId)
                      ? {
                          ...worktree,
                          collectionIds: worktree.collectionIds.filter((id) => id !== collectionId)
                        }
                      : worktree
                  )
                : worktrees
            ])
          )
          const nextCollapsedGroups = new Set(
            [...state.collapsedGroups].filter(
              (key) => key !== collectionGroupPrefix && !key.startsWith(`${collectionGroupPrefix}:`)
            )
          )
          const collapsedGroupsChanged = nextCollapsedGroups.size !== state.collapsedGroups.size
          set((s) => ({
            collections: s.collections.filter((collection) => collection.id !== collectionId),
            worktreesByRepo: nextWorktreesByRepo,
            ...(collapsedGroupsChanged ? { collapsedGroups: nextCollapsedGroups } : {})
          }))
          if (collapsedGroupsChanged) {
            window.api.ui.set({ collapsedGroups: [...nextCollapsedGroups] }).catch(console.error)
          }
        }
        return deleted
      } catch (err) {
        console.error('Failed to delete collection:', err)
        return false
      }
    }
  }
}
