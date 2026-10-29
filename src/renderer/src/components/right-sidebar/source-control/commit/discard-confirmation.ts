import { basename } from '@/lib/path'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { DiscardAllArea } from '../../../../../../shared/source-control-discard-all-sequence'
import { translate } from '@/i18n/i18n'

export type DiscardConfirmationCopy = {
  title: string
  description: string
  confirmLabel: string
  deleteAction: boolean
}

/** Discard deletes untracked files; staged additions retain their index version. */
export function discardDeletesEntryFile(entry: Pick<GitStatusEntry, 'area' | 'status'>): boolean {
  return entry.area === 'untracked' || entry.status === 'untracked'
}

export function getDiscardEntryConfirmationCopy(
  entry: Pick<GitStatusEntry, 'area' | 'path' | 'status'>
): DiscardConfirmationCopy {
  const name = basename(entry.path)

  if (discardDeletesEntryFile(entry)) {
    return {
      title: translate(
        'auto.components.right.sidebar.source.control.discard.confirmation.96c772bee9',
        'Delete "{{value0}}"?',
        { value0: name }
      ),
      description: translate(
        'auto.components.right.sidebar.source.control.discard.confirmation.d97bf697c9',
        'This will permanently delete this file. This cannot be undone.'
      ),
      deleteAction: true,
      confirmLabel: translate('sourceControl.discard.delete', 'Delete')
    }
  }

  if (entry.status === 'deleted') {
    return {
      title: translate(
        'auto.components.right.sidebar.source.control.discard.confirmation.5c0bdbc4cb',
        'Restore "{{value0}}"?',
        { value0: name }
      ),
      description: translate(
        'sourceControl.discard.restoreStagedVersionDescription',
        'This will restore the last staged version and discard the deletion. This cannot be undone.'
      ),
      deleteAction: false,
      confirmLabel: translate('sourceControl.discard.restore', 'Restore')
    }
  }

  return {
    title: translate(
      'auto.components.right.sidebar.source.control.discard.confirmation.d4df3a61df',
      'Discard changes to "{{value0}}"?',
      { value0: name }
    ),
    description: translate(
      'sourceControl.discard.unstagedChangesDescription',
      'This will revert the unstaged changes to this file. This cannot be undone.'
    ),
    deleteAction: false,
    confirmLabel: translate('sourceControl.discard.discard', 'Discard')
  }
}

export function getDiscardAreaConfirmationCopy(
  area: DiscardAllArea,
  count: number
): DiscardConfirmationCopy {
  switch (area) {
    case 'untracked':
      return {
        title:
          count === 1
            ? translate(
                'sourceControl.discard.deleteUntrackedTitle_one',
                'Delete {{count}} untracked file?',
                { count }
              )
            : translate(
                'sourceControl.discard.deleteUntrackedTitle_other',
                'Delete {{count}} untracked files?',
                { count }
              ),
        description:
          count === 1
            ? translate(
                'sourceControl.discard.deleteUntrackedFileDescription',
                'This will permanently delete this untracked file. This cannot be undone.'
              )
            : translate(
                'sourceControl.discard.deleteUntrackedFilesDescription_other',
                'This will permanently delete these {{count}} untracked files. This cannot be undone.',
                { count }
              ),
        deleteAction: true,
        confirmLabel:
          count === 1
            ? translate('sourceControl.discard.delete', 'Delete')
            : translate('sourceControl.discard.deleteCount', 'Delete {{count}}', { count })
      }
    case 'staged':
      return {
        title: translate(
          'auto.components.right.sidebar.source.control.discard.confirmation.5ddd8cac7f',
          'Discard all staged changes?'
        ),
        description: translate(
          'auto.components.right.sidebar.source.control.discard.confirmation.ddf36f291c',
          'This will unstage and revert all staged changes. Staged new files will be deleted. This cannot be undone.'
        ),
        deleteAction: false,
        confirmLabel: translate('sourceControl.discard.discardAll', 'Discard all')
      }
    case 'unstaged':
      return {
        title: translate(
          'auto.components.right.sidebar.source.control.discard.confirmation.2ae5a785b3',
          'Discard all unstaged changes?'
        ),
        description:
          count === 1
            ? translate(
                'sourceControl.discard.unstagedSelectionIncludingUntrackedDescription',
                'This will revert unstaged changes and permanently delete any untracked files in this selection. This cannot be undone.'
              )
            : translate(
                'sourceControl.discard.unstagedFilesIncludingUntrackedDescription_other',
                'This will revert unstaged changes and permanently delete any untracked files among these {{count}} files. This cannot be undone.',
                { count }
              ),
        deleteAction: false,
        confirmLabel: translate('sourceControl.discard.discardAll', 'Discard all')
      }
  }
}
