import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { Collection } from '../../../../../../shared/collection-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeMetaBatchUpdate } from '@/store/slices/worktree-helpers'
import { assignCollectionMembership } from '../../../../../../shared/collections'

export type CollectionDialogs = ReturnType<typeof useCollectionDialogs>

// Delete/add-worktrees flows for collections, plus the drop-on-header membership commit.
export function useCollectionDialogs(args: { worktreeMap: Map<string, Worktree> }) {
  const { worktreeMap } = args
  const deleteCollection = useAppStore((s) => s.deleteCollection)
  const updateWorktreesMeta = useAppStore((s) => s.updateWorktreesMeta)
  const [collectionDeleteDialog, setCollectionDeleteDialog] = useState<{
    collectionId: string
    name: string
  } | null>(null)
  const [addWorktreesCollection, setAddWorktreesCollection] = useState<Collection | null>(null)

  const handleDeleteCollection = useCallback((collectionId: string, name: string) => {
    setCollectionDeleteDialog({ collectionId, name })
  }, [])

  const handleAddWorktreesToCollection = useCallback((collection: Collection) => {
    setAddWorktreesCollection(collection)
  }, [])

  const handleDropWorktreesOnCollection = useCallback(
    (worktreeIds: readonly string[], collectionId: string) => {
      const updates: WorktreeMetaBatchUpdate[] = []
      for (const worktreeId of worktreeIds) {
        const worktree = worktreeMap.get(worktreeId)
        if (!worktree || worktree.collectionIds?.includes(collectionId)) {
          continue
        }
        updates.push({
          worktreeId,
          updates: {
            collectionIds: assignCollectionMembership(worktree.collectionIds, collectionId, {
              exclusive: !worktree.isMainWorktree
            })
          }
        })
      }
      if (updates.length > 0) {
        void updateWorktreesMeta(updates)
      }
    },
    [worktreeMap, updateWorktreesMeta]
  )

  const handleConfirmDeleteCollection = useCallback(async (): Promise<boolean> => {
    if (!collectionDeleteDialog) {
      return false
    }
    const deleted = await deleteCollection(collectionDeleteDialog.collectionId)
    if (!deleted) {
      toast.error(
        translate(
          'auto.components.sidebar.WorktreeList.collectionDeleteFailed',
          'Failed to delete collection'
        )
      )
      return false
    }
    // Why: the dialog owns the close — clearing state here races its finally block.
    return true
  }, [collectionDeleteDialog, deleteCollection])

  return {
    collectionDeleteDialog,
    setCollectionDeleteDialog,
    addWorktreesCollection,
    setAddWorktreesCollection,
    handleDeleteCollection,
    handleAddWorktreesToCollection,
    handleDropWorktreesOnCollection,
    handleConfirmDeleteCollection
  }
}
