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
import { perforceChangelistLabel } from './perforce-changelist-label'
import type {
  PerforceChangelist,
  PerforceEntry
} from '../../../../../shared/perforce/perforce-types'
import { translate } from '@/i18n/i18n'

/** Right-click menu for checked-out files: move them between changelists or revert them. */
export function PerforceFileContextMenu({
  targets,
  changelists,
  onOpen,
  onMoveToChangelist,
  onMoveToNewChangelist,
  onRevert,
  onShelveChanges,
  children
}: {
  /** Opened files the menu acts on (the selection, or the clicked row). */
  targets: PerforceEntry[]
  changelists: PerforceChangelist[]
  onOpen: () => void
  onMoveToChangelist: (changelist: 'default' | number) => void
  onMoveToNewChangelist: () => void
  onRevert: () => void
  onShelveChanges: () => void
  children: ReactNode
}) {
  const everyTargetIn = (changelist: 'default' | number): boolean =>
    targets.every((entry) => entry.changelist === changelist)
  const destinations = [
    ...(everyTargetIn('default')
      ? []
      : [
          {
            id: 'default' as const,
            label: translate('perforce.ui.defaultChangelist', 'Default changelist')
          }
        ]),
    ...changelists
      .filter((changelist) => !everyTargetIn(changelist.id))
      .map((changelist) => ({
        id: changelist.id,
        label: perforceChangelistLabel(changelist)
      }))
  ]
  const noun =
    targets.length === 1
      ? translate('perforce.ui.oneFile', 'file')
      : translate('perforce.ui.manyFiles', '{{total}} files', { total: targets.length })
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={destinations.length === 0}>
            {translate('perforce.ui.moveToExistingChangelist', 'Move to existing changelist')}
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
          {translate('perforce.ui.moveFilesToNewChangelist', 'Move {{noun}} to new changelist…', {
            noun
          })}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onOpen}>
          {translate('perforce.ui.openFile', 'Open file')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={targets.some((entry) => entry.changelist === 'default')}
          onSelect={onShelveChanges}
        >
          {translate('perforce.ui.shelveChanges', 'Shelve changes')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onRevert}>
          {translate('perforce.ui.revertChanges', 'Revert changes')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
