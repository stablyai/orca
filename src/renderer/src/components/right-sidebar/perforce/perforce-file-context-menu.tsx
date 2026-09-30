import type { ReactNode } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import type {
  PerforceChangelist,
  PerforceEntry
} from '../../../../../shared/perforce/perforce-types'

/** Right-click menu for checked-out files: move them between changelists or revert them. */
export function PerforceFileContextMenu({
  targets,
  changelists,
  onMoveToChangelist,
  onMoveToNewChangelist,
  onRevert,
  onShelveChanges,
  children
}: {
  /** Opened files the menu acts on (the selection, or the clicked row). */
  targets: PerforceEntry[]
  changelists: PerforceChangelist[]
  onMoveToChangelist: (changelist: 'default' | number) => void
  onMoveToNewChangelist: () => void
  onRevert: () => void
  onShelveChanges: () => void
  children: ReactNode
}) {
  const everyTargetIn = (changelist: 'default' | number): boolean =>
    targets.every((entry) => entry.changelist === changelist)
  const destinations = [
    ...(everyTargetIn('default') ? [] : [{ id: 'default' as const, label: 'Default changelist' }]),
    ...changelists
      .filter((changelist) => !everyTargetIn(changelist.id))
      .map((changelist) => ({
        id: changelist.id,
        label: `Changelist ${changelist.id}${changelist.description ? ` · ${changelist.description.split('\n')[0]}` : ''}`
      }))
  ]
  const noun = targets.length === 1 ? 'file' : `${targets.length} files`
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={destinations.length === 0}>
            Move to existing changelist
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-w-80">
            {destinations.map((destination) => (
              <ContextMenuItem
                key={destination.id}
                onSelect={() => onMoveToChangelist(destination.id)}
              >
                <span className="truncate">{destination.label}</span>
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onMoveToNewChangelist}>
          Move {noun} to new changelist…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={targets.some((entry) => entry.changelist === 'default')}
          onSelect={onShelveChanges}
        >
          Shelf changes
        </ContextMenuItem>
        <ContextMenuItem onSelect={onRevert}>Revert changes</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
