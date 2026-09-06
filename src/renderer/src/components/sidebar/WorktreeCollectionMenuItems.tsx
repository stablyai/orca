import { CircleX, Layers, Plus } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { useWorktreeCollectionActions } from './use-worktree-collection-actions'

export function WorktreeCollectionMenuItems({
  actions,
  isDeleting
}: {
  actions: ReturnType<typeof useWorktreeCollectionActions>
  isDeleting: boolean
}) {
  const {
    addableCollections,
    exclusiveCollectionMembership,
    handleAddToCollection,
    handleRemoveFromCollection,
    memberCollections,
    setCreateCollectionDialogOpen
  } = actions

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={isDeleting}>
          <Layers className="size-3.5" />
          {exclusiveCollectionMembership && memberCollections.length > 0
            ? translate(
                'auto.components.sidebar.WorktreeContextMenu.moveToCollection',
                'Move to Collection'
              )
            : translate(
                'auto.components.sidebar.WorktreeContextMenu.addToCollection',
                'Add to Collection'
              )}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-48">
          {addableCollections.map((collection) => (
            <DropdownMenuItem
              key={collection.id}
              onSelect={() => handleAddToCollection(collection.id)}
            >
              <span className="max-w-48 truncate">{collection.name}</span>
            </DropdownMenuItem>
          ))}
          {addableCollections.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={() => setCreateCollectionDialogOpen(true)}>
            <Plus className="size-3.5" />
            {translate(
              'auto.components.sidebar.WorktreeContextMenu.newCollection',
              'New Collection…'
            )}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {memberCollections.length > 0 ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={isDeleting}>
            <CircleX className="size-3.5" />
            {translate(
              'auto.components.sidebar.WorktreeContextMenu.removeFromCollection',
              'Remove from Collection'
            )}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-48">
            {memberCollections.map((collection) => (
              <DropdownMenuItem
                key={collection.id}
                onSelect={() => handleRemoveFromCollection(collection.id)}
              >
                <span className="max-w-48 truncate">{collection.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
    </>
  )
}
