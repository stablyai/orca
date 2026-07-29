import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/types'
import {
  canDiscardStatusEntry,
  canStageStatusEntry,
  canUnstageStatusEntry
} from './source-control-entry-actions'

function entry(overrides: Partial<GitStatusEntry>): GitStatusEntry {
  return {
    path: 'file.ts',
    status: 'modified',
    area: 'unstaged',
    ...overrides
  } as GitStatusEntry
}

describe('source control entry actions', () => {
  it('hides Unstage for submodule-internal staged rows but keeps it for normal staged rows', () => {
    expect(canUnstageStatusEntry(entry({ area: 'staged' }))).toBe(true)
    expect(canUnstageStatusEntry(entry({ area: 'staged', submoduleRoot: 'vendor/lib' }))).toBe(
      false
    )
    expect(canUnstageStatusEntry(entry({ area: 'unstaged' }))).toBe(false)
  })

  it('hides Discard for submodule-internal rows and conflict rows, keeps it for normal rows', () => {
    expect(canDiscardStatusEntry(entry({ area: 'unstaged' }))).toBe(true)
    expect(canDiscardStatusEntry(entry({ area: 'untracked', status: 'untracked' }))).toBe(true)
    expect(canDiscardStatusEntry(entry({ area: 'unstaged', submoduleRoot: 'vendor/lib' }))).toBe(
      false
    )
    expect(canDiscardStatusEntry(entry({ area: 'staged' }))).toBe(false)
    expect(canDiscardStatusEntry(entry({ area: 'unstaged', conflictStatus: 'unresolved' }))).toBe(
      false
    )
    expect(
      canDiscardStatusEntry(entry({ area: 'unstaged', conflictStatus: 'resolved_locally' }))
    ).toBe(false)
  })

  it('hides Stage for submodule-internal rows', () => {
    expect(canStageStatusEntry(entry({ area: 'unstaged' }))).toBe(true)
    expect(canStageStatusEntry(entry({ area: 'unstaged', submoduleRoot: 'vendor/lib' }))).toBe(
      false
    )
  })
})
