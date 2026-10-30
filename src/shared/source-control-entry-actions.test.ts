import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from './git-status-types'
import { canOpenWorkingTreeStatusEntry } from './source-control-entry-actions'

function entry(overrides: Partial<GitStatusEntry>): GitStatusEntry {
  return {
    path: 'file.ts',
    status: 'modified',
    area: 'unstaged',
    ...overrides
  } as GitStatusEntry
}

describe('canOpenWorkingTreeStatusEntry', () => {
  it('hides Open file for deleted rows and keeps it for rows that still exist on disk', () => {
    expect(canOpenWorkingTreeStatusEntry(entry({ status: 'modified' }))).toBe(true)
    expect(canOpenWorkingTreeStatusEntry(entry({ status: 'added' }))).toBe(true)
    expect(canOpenWorkingTreeStatusEntry(entry({ status: 'untracked' }))).toBe(true)
    expect(canOpenWorkingTreeStatusEntry(entry({ status: 'renamed' }))).toBe(true)
    expect(canOpenWorkingTreeStatusEntry(entry({ area: 'staged', status: 'modified' }))).toBe(true)
    expect(canOpenWorkingTreeStatusEntry(entry({ status: 'deleted' }))).toBe(false)
    expect(canOpenWorkingTreeStatusEntry(entry({ area: 'staged', status: 'deleted' }))).toBe(false)
    expect(
      canOpenWorkingTreeStatusEntry(
        entry({
          path: 'vendor/lib',
          submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false }
        })
      )
    ).toBe(false)
  })
})
