import { describe, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_STATUSES, sanitizeFilterWorkspaceStatuses } from './workspace-statuses'
import type { WorkspaceStatusDefinition } from './worktree/types'

const STATUSES: readonly WorkspaceStatusDefinition[] = DEFAULT_WORKSPACE_STATUSES

describe('sanitizeFilterWorkspaceStatuses', () => {
  it('keeps ids that still exist in the catalog', () => {
    expect(sanitizeFilterWorkspaceStatuses(['todo', 'completed'], STATUSES)).toEqual([
      'todo',
      'completed'
    ])
  })

  it('drops ids for statuses the catalog no longer defines', () => {
    // The restart case: a custom status was deleted while a filter named it.
    // Without this, the sidebar comes back empty with no visible cause.
    expect(sanitizeFilterWorkspaceStatuses(['deleted-custom', 'todo'], STATUSES)).toEqual(['todo'])
  })

  it('collapses a selection naming every status back to "all"', () => {
    expect(
      sanitizeFilterWorkspaceStatuses(
        STATUSES.map((status) => status.id),
        STATUSES
      )
    ).toEqual([])
  })

  it('collapses to "all" when every selected id was pruned', () => {
    expect(sanitizeFilterWorkspaceStatuses(['gone-a', 'gone-b'], STATUSES)).toEqual([])
  })

  it('keeps the surviving id when stale ids alone reach the catalog size', () => {
    // Why this case: counting stale ids toward the "everything is selected"
    // check would collapse a real one-status filter back to "all" — the filter
    // would silently stop applying after an unrelated status was deleted.
    expect(
      sanitizeFilterWorkspaceStatuses(['todo', 'gone-a', 'gone-b', 'gone-c'], STATUSES)
    ).toEqual(['todo'])
  })

  it('reorders into catalog order so the label and persisted value stay stable', () => {
    expect(sanitizeFilterWorkspaceStatuses(['completed', 'todo'], STATUSES)).toEqual([
      'todo',
      'completed'
    ])
  })

  it('de-duplicates repeated ids', () => {
    expect(sanitizeFilterWorkspaceStatuses(['todo', 'todo'], STATUSES)).toEqual(['todo'])
  })

  it('treats non-array persisted payloads as no filter', () => {
    expect(sanitizeFilterWorkspaceStatuses(undefined, STATUSES)).toEqual([])
    expect(sanitizeFilterWorkspaceStatuses('todo', STATUSES)).toEqual([])
    expect(sanitizeFilterWorkspaceStatuses([1, null, {}], STATUSES)).toEqual([])
  })

  it('returns the same array identity when nothing changed', () => {
    // Why: this runs on every catalog edit; a fresh array would wake the
    // debounced persisted-UI writer for a no-op normalization.
    const already = ['todo', 'completed']
    expect(sanitizeFilterWorkspaceStatuses(already, STATUSES)).toBe(already)

    const empty: string[] = []
    expect(sanitizeFilterWorkspaceStatuses(empty, STATUSES)).toBe(empty)
  })

  it('returns a new array when the selection actually changed', () => {
    const stale = ['completed', 'gone']
    expect(sanitizeFilterWorkspaceStatuses(stale, STATUSES)).not.toBe(stale)
  })
})
