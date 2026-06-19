import { describe, expect, it } from 'vitest'
import {
  getDiscardAreaConfirmationCopy,
  getDiscardEntryConfirmationCopy
} from './source-control-discard-confirmation'
import type { GitStatusEntry } from '../../../../shared/types'

function entry(partial: Partial<GitStatusEntry> & { path: string }): GitStatusEntry {
  return {
    area: 'unstaged',
    status: 'modified',
    ...partial
  }
}

describe('getDiscardEntryConfirmationCopy', () => {
  it('uses delete copy for untracked files', () => {
    expect(
      getDiscardEntryConfirmationCopy(
        entry({ area: 'untracked', path: 'src/new-file.ts', status: 'untracked' })
      )
    ).toEqual({
      title: 'Delete "new-file.ts"?',
      description: 'This will permanently delete this file. This cannot be undone.',
      confirmLabel: 'Delete'
    })
  })

  it('uses delete copy for files added to the index', () => {
    expect(
      getDiscardEntryConfirmationCopy(
        entry({ area: 'staged', path: 'src/added.ts', status: 'added' })
      )
    ).toEqual({
      title: 'Delete "added.ts"?',
      description: 'This will permanently delete this file. This cannot be undone.',
      confirmLabel: 'Delete'
    })
  })

  it('uses restore copy for deleted tracked files', () => {
    expect(
      getDiscardEntryConfirmationCopy(
        entry({ area: 'unstaged', path: 'src/removed.ts', status: 'deleted' })
      )
    ).toEqual({
      title: 'Restore "removed.ts"?',
      description:
        'This will restore the file from HEAD and discard the deletion. This cannot be undone.',
      confirmLabel: 'Restore'
    })
  })

  it('uses discard copy for modified tracked files', () => {
    expect(
      getDiscardEntryConfirmationCopy(entry({ path: 'src/changed.ts', status: 'modified' }))
    ).toEqual({
      title: 'Discard changes to "changed.ts"?',
      description: 'This will revert all changes to this file. This cannot be undone.',
      confirmLabel: 'Discard'
    })
  })

  it('handles Windows-style paths', () => {
    expect(
      getDiscardEntryConfirmationCopy(
        entry({ area: 'untracked', path: 'src\\windows-file.ts', status: 'untracked' })
      ).title
    ).toBe('Delete "windows-file.ts"?')
  })
})

describe('getDiscardAreaConfirmationCopy', () => {
  it('uses singular delete copy for one untracked file', () => {
    expect(getDiscardAreaConfirmationCopy('untracked', 1)).toEqual({
      title: 'Delete 1 untracked file?',
      description: 'This will permanently delete this untracked file. This cannot be undone.',
      confirmLabel: 'Delete'
    })
  })

  it('uses plural delete copy for multiple untracked files', () => {
    expect(getDiscardAreaConfirmationCopy('untracked', 3)).toEqual({
      title: 'Delete 3 untracked files?',
      description: 'This will permanently delete these 3 untracked files. This cannot be undone.',
      confirmLabel: 'Delete 3'
    })
  })

  it('warns that staged new files will be deleted', () => {
    expect(getDiscardAreaConfirmationCopy('staged', 4)).toEqual({
      title: 'Discard all staged changes?',
      description:
        'This will unstage and revert all staged changes. Staged new files will be deleted. This cannot be undone.',
      confirmLabel: 'Discard all'
    })
  })

  it('uses singular unstaged copy', () => {
    expect(getDiscardAreaConfirmationCopy('unstaged', 1)).toEqual({
      title: 'Discard all unstaged changes?',
      description: 'This will revert the unstaged changes in 1 file. This cannot be undone.',
      confirmLabel: 'Discard all'
    })
  })

  it('uses plural unstaged copy', () => {
    expect(getDiscardAreaConfirmationCopy('unstaged', 2)).toEqual({
      title: 'Discard all unstaged changes?',
      description: 'This will revert unstaged changes in 2 files. This cannot be undone.',
      confirmLabel: 'Discard all'
    })
  })
})
