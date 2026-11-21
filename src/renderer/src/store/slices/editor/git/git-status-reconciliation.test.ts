import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { areGitStatusEntriesEqual } from './git-status-reconciliation'

describe('areGitStatusEntriesEqual', () => {
  it('treats a submodule that gained a tracked edit under the same status as changed', () => {
    const movedOnly: GitStatusEntry = {
      path: 'apps/trader',
      status: 'modified',
      area: 'unstaged',
      submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false }
    }
    const movedAndEdited: GitStatusEntry = {
      ...movedOnly,
      submodule: { commitChanged: true, trackedChanges: true, untrackedChanges: false }
    }

    expect(areGitStatusEntriesEqual([movedOnly], [movedAndEdited])).toBe(false)
  })
})
