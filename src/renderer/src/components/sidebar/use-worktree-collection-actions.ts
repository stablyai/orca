import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import type { Collection } from '../../../../shared/collection-types'
import { assignCollectionMembership, sortCollectionsByOrder } from '../../../../shared/collections'
import type { Worktree } from '../../../../shared/worktree/types'

const EMPTY_COLLECTIONS: readonly Collection[] = []

/** Collection membership gestures for one worktree's context menu. */
export function useWorktreeCollectionActions(worktree: Worktree) {
  const collections = useAppStore((s) => s.collections ?? EMPTY_COLLECTIONS)
  const createCollection = useAppStore((s) => s.createCollection)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const [createCollectionDialogOpen, setCreateCollectionDialogOpen] = useState(false)

  const sortedCollections = useMemo(() => sortCollectionsByOrder(collections), [collections])
  const memberCollections = useMemo(
    () => sortedCollections.filter((entry) => worktree.collectionIds?.includes(entry.id)),
    [sortedCollections, worktree.collectionIds]
  )
  const addableCollections = useMemo(
    () => sortedCollections.filter((entry) => !worktree.collectionIds?.includes(entry.id)),
    [sortedCollections, worktree.collectionIds]
  )
  // Why: a feature worktree lives in exactly one workstream, so the gesture is
  // a move; only the primary checkout (shared infrastructure) may sit in many.
  const exclusiveCollectionMembership = !worktree.isMainWorktree

  const handleAddToCollection = useCallback(
    (collectionId: string) => {
      void updateWorktreeMeta(worktree.id, {
        collectionIds: assignCollectionMembership(worktree.collectionIds, collectionId, {
          exclusive: exclusiveCollectionMembership
        })
      })
    },
    [updateWorktreeMeta, worktree.id, worktree.collectionIds, exclusiveCollectionMembership]
  )
  const handleRemoveFromCollection = useCallback(
    (collectionId: string) => {
      void updateWorktreeMeta(worktree.id, {
        collectionIds: (worktree.collectionIds ?? []).filter((id) => id !== collectionId)
      })
    },
    [updateWorktreeMeta, worktree.id, worktree.collectionIds]
  )
  const handleSubmitNewCollection = useCallback(
    async (name: string) => {
      const created = await createCollection(name)
      if (created) {
        await updateWorktreeMeta(worktree.id, {
          collectionIds: assignCollectionMembership(worktree.collectionIds, created.id, {
            exclusive: exclusiveCollectionMembership
          })
        })
      }
    },
    [
      createCollection,
      updateWorktreeMeta,
      worktree.id,
      worktree.collectionIds,
      exclusiveCollectionMembership
    ]
  )

  return {
    addableCollections,
    createCollectionDialogOpen,
    exclusiveCollectionMembership,
    handleAddToCollection,
    handleRemoveFromCollection,
    handleSubmitNewCollection,
    memberCollections,
    setCreateCollectionDialogOpen
  }
}
