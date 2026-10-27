import { describe, expect, it } from 'vitest'
import {
  getDiscardAreaConfirmationCopy,
  getDiscardEntryConfirmationCopy
} from './source-control/commit/discard-confirmation'
import type { GitStatusEntry } from '../../../../shared/git-status-types'

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

  it('preserves staged additions when discarding working edits', () => {
    expect(
      getDiscardEntryConfirmationCopy(
        entry({ area: 'staged', path: 'src/added.ts', status: 'added' })
      )
    ).toEqual({
      title: 'Discard changes to "added.ts"?',
      description: 'This will revert the unstaged changes to this file. This cannot be undone.',
      confirmLabel: 'Discard'
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
        'This will restore the last staged version and discard the deletion. This cannot be undone.',
      confirmLabel: 'Restore'
    })
  })
})

describe('getDiscardAreaConfirmationCopy', () => {
  it('warns that staged new files will be deleted', () => {
    expect(getDiscardAreaConfirmationCopy('staged', 4)).toEqual({
      title: 'Discard all staged changes?',
      description:
        'This will unstage and revert all staged changes. Staged new files will be deleted. This cannot be undone.',
      confirmLabel: 'Discard all'
    })
  })

  it('uses plural unstaged copy', () => {
    expect(getDiscardAreaConfirmationCopy('unstaged', 2)).toEqual({
      title: 'Discard all unstaged changes?',
      description:
        'This will revert unstaged changes and permanently delete any untracked files among these 2 files. This cannot be undone.',
      confirmLabel: 'Discard all'
    })
  })
})
