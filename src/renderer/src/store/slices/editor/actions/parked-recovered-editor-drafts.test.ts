import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClosedEditorTabSnapshot } from '../types/open-file'
import {
  deferRecoveredEditorDraft,
  parkRecoveredEditorDrafts,
  type ParkedRecoveredEditorDrafts
} from './parked-recovered-editor-drafts'

const WORKTREE_ID = 'repo-1::/workspace'

function snapshot(index: number): ClosedEditorTabSnapshot {
  return {
    filePath: `/workspace/draft-${index}.ts`,
    relativePath: `draft-${index}.ts`,
    worktreeId: WORKTREE_ID,
    language: 'typescript',
    mode: 'edit',
    dirtyDraftContent: `draft ${index}`
  }
}

/** A plain close with nothing unsaved — the entry the cap may evict without losing text. */
function savedSnapshot(index: number): ClosedEditorTabSnapshot {
  const { dirtyDraftContent: _draft, ...rest } = snapshot(index)
  return { ...rest, filePath: `/workspace/saved-${index}.ts`, relativePath: `saved-${index}.ts` }
}

const EMPTY: ParkedRecoveredEditorDrafts = {
  recentlyClosedEditorTabsByWorktree: {},
  recentlyClosedTabKindsByWorktree: {}
}

describe('parkRecoveredEditorDrafts', () => {
  it('pairs every parked snapshot with one cross-type reopen entry', () => {
    for (const count of [1, 3, 10]) {
      const snapshots = Array.from({ length: count }, (_value, index) => snapshot(index))

      const parked = parkRecoveredEditorDrafts(EMPTY, WORKTREE_ID, snapshots)

      expect(parked.recentlyClosedEditorTabsByWorktree[WORKTREE_ID]).toHaveLength(count)
      expect(parked.recentlyClosedTabKindsByWorktree[WORKTREE_ID]).toEqual(
        Array.from({ length: count }, () => 'editor')
      )
    }
  })

  it('pushes one kind per snapshot that survives the editor-stack cap', () => {
    const snapshots = Array.from({ length: 24 }, (_value, index) => snapshot(index))

    const parked = parkRecoveredEditorDrafts(EMPTY, WORKTREE_ID, snapshots)

    const stack = parked.recentlyClosedEditorTabsByWorktree[WORKTREE_ID]
    const kinds = parked.recentlyClosedTabKindsByWorktree[WORKTREE_ID]
    expect(stack.length).toBeLessThan(snapshots.length)
    expect(kinds).toHaveLength(stack.length)
    expect(kinds.every((kind) => kind === 'editor')).toBe(true)
  })

  it('keeps kinds paired with snapshots when the cap evicts what was already parked', () => {
    const existing = parkRecoveredEditorDrafts(
      EMPTY,
      WORKTREE_ID,
      Array.from({ length: 8 }, (_value, index) => snapshot(index))
    )

    const parked = parkRecoveredEditorDrafts(existing, WORKTREE_ID, [snapshot(20), snapshot(21)])

    expect(parked.recentlyClosedTabKindsByWorktree[WORKTREE_ID]).toHaveLength(
      parked.recentlyClosedEditorTabsByWorktree[WORKTREE_ID].length
    )
  })

  it('stacks newest first on top of what the worktree already parked', () => {
    const existing = parkRecoveredEditorDrafts(EMPTY, WORKTREE_ID, [snapshot(1)])

    const parked = parkRecoveredEditorDrafts(existing, WORKTREE_ID, [snapshot(2)])

    expect(
      parked.recentlyClosedEditorTabsByWorktree[WORKTREE_ID].map((entry) => entry.filePath)
    ).toEqual(['/workspace/draft-2.ts', '/workspace/draft-1.ts'])
    expect(parked.recentlyClosedTabKindsByWorktree[WORKTREE_ID]).toEqual(['editor', 'editor'])
  })

  it('leaves both stacks untouched when there is nothing to park', () => {
    const existing = parkRecoveredEditorDrafts(EMPTY, WORKTREE_ID, [snapshot(1)])

    const parked = parkRecoveredEditorDrafts(existing, WORKTREE_ID, [])

    expect(parked.recentlyClosedEditorTabsByWorktree).toBe(
      existing.recentlyClosedEditorTabsByWorktree
    )
    expect(parked.recentlyClosedTabKindsByWorktree).toBe(existing.recentlyClosedTabKindsByWorktree)
  })
})

describe('deferRecoveredEditorDraft', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it('appends the snapshot and its kind to the back of both stacks', () => {
    const existing = parkRecoveredEditorDrafts(EMPTY, WORKTREE_ID, [snapshot(1), snapshot(2)])

    const deferred = deferRecoveredEditorDraft(existing, WORKTREE_ID, snapshot(3))

    expect(
      deferred.recentlyClosedEditorTabsByWorktree[WORKTREE_ID].map((entry) => entry.filePath)
    ).toEqual(['/workspace/draft-1.ts', '/workspace/draft-2.ts', '/workspace/draft-3.ts'])
    expect(deferred.recentlyClosedTabKindsByWorktree[WORKTREE_ID]).toEqual([
      'editor',
      'editor',
      'editor'
    ])
  })

  it('pairs a front park and a tail defer one kind entry each', () => {
    const parked = parkRecoveredEditorDrafts(EMPTY, WORKTREE_ID, [snapshot(1)])

    const deferred = deferRecoveredEditorDraft(parked, WORKTREE_ID, snapshot(2))

    expect(deferred.recentlyClosedEditorTabsByWorktree[WORKTREE_ID]).toHaveLength(
      deferred.recentlyClosedTabKindsByWorktree[WORKTREE_ID].length
    )
  })

  it('evicts the oldest saved close at the cap so the recovered draft survives', () => {
    const full = parkRecoveredEditorDrafts(EMPTY, WORKTREE_ID, [
      ...Array.from({ length: 9 }, (_value, index) => snapshot(index)),
      savedSnapshot(0)
    ])

    const deferred = deferRecoveredEditorDraft(full, WORKTREE_ID, snapshot(99))

    const stack = deferred.recentlyClosedEditorTabsByWorktree[WORKTREE_ID]
    expect(stack).toHaveLength(10)
    expect(stack.at(-1)?.filePath).toBe('/workspace/draft-99.ts')
    expect(stack.some((entry) => entry.filePath === '/workspace/saved-0.ts')).toBe(false)
    // A kind with no snapshot behind it would make a cross-type reopen pop a missing editor.
    expect(deferred.recentlyClosedTabKindsByWorktree[WORKTREE_ID]).toEqual(
      full.recentlyClosedTabKindsByWorktree[WORKTREE_ID]
    )
  })

  it('drops the deferred snapshot when every entry at the cap holds unsaved text', () => {
    const full = parkRecoveredEditorDrafts(
      EMPTY,
      WORKTREE_ID,
      Array.from({ length: 10 }, (_value, index) => snapshot(index))
    )

    const deferred = deferRecoveredEditorDraft(full, WORKTREE_ID, snapshot(99))

    expect(deferred.recentlyClosedEditorTabsByWorktree).toBe(
      full.recentlyClosedEditorTabsByWorktree
    )
    expect(deferred.recentlyClosedTabKindsByWorktree).toBe(full.recentlyClosedTabKindsByWorktree)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/workspace/draft-99.ts'))
  })
})
