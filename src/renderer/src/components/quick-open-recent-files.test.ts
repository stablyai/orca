import { describe, expect, it } from 'vitest'
import type { ClosedEditorTabSnapshot, OpenFile } from '@/store/slices/editor'
import { orderQuickOpenByRecency, recentQuickOpenPaths } from './quick-open-recent-files'

const WT = 'wt-1'

function openFile(partial: Partial<OpenFile> & { relativePath: string }): OpenFile {
  return {
    id: `editor:${WT}:rt:/repo/${partial.relativePath}`,
    filePath: `/repo/${partial.relativePath}`,
    worktreeId: WT,
    language: 'typescript',
    isDirty: false,
    ...partial
  } as OpenFile
}

function closed(
  partial: Partial<ClosedEditorTabSnapshot> & { relativePath: string }
): ClosedEditorTabSnapshot {
  return {
    filePath: `/repo/${partial.relativePath}`,
    worktreeId: WT,
    language: 'typescript',
    ...partial
  } as ClosedEditorTabSnapshot
}

describe('recentQuickOpenPaths', () => {
  it('orders open files by true tab MRU (mruOpenFileIds), then recently-closed', () => {
    const a = openFile({ relativePath: 'a.ts' })
    const b = openFile({ relativePath: 'b.ts' })
    // MRU says a was visited more recently than b, even though b was opened later.
    const result = recentQuickOpenPaths({
      mruOpenFileIds: [a.id, b.id],
      openFiles: [a, b],
      recentlyClosed: [closed({ relativePath: 'c.ts' })],
      activeWorktreeId: WT,
      activeFileId: null
    })
    expect(result).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('falls back to newest-open-first for files the MRU stack omits', () => {
    const a = openFile({ relativePath: 'a.ts' })
    const b = openFile({ relativePath: 'b.ts' })
    // Empty MRU (e.g. single-tab group) — order comes from open order, reversed.
    const result = recentQuickOpenPaths({
      mruOpenFileIds: [],
      openFiles: [a, b],
      recentlyClosed: [],
      activeWorktreeId: WT,
      activeFileId: null
    })
    expect(result).toEqual(['b.ts', 'a.ts'])
  })

  it('excludes the active file via its opaque id, even if it lingers in recently-closed', () => {
    // Why: OpenFile.id is 'editor:<wt>:<runtime>:<path>', never the path, so the
    // active file must be resolved to its relative path before excluding it.
    const active = openFile({ relativePath: 'a.ts' })
    const b = openFile({ relativePath: 'b.ts' })
    const result = recentQuickOpenPaths({
      mruOpenFileIds: [active.id, b.id],
      openFiles: [active, b],
      recentlyClosed: [closed({ relativePath: 'a.ts' }), closed({ relativePath: 'c.ts' })],
      activeWorktreeId: WT,
      activeFileId: active.id
    })
    expect(result).toEqual(['b.ts', 'c.ts'])
  })

  it('skips non-plain files (diffs, untitled) and other worktrees', () => {
    const files = [
      openFile({ relativePath: 'diff.ts', diffSource: {} as OpenFile['diffSource'] }),
      openFile({ relativePath: 'draft.ts', isUntitled: true }),
      openFile({ relativePath: 'other.ts', worktreeId: 'wt-2' }),
      openFile({ relativePath: 'real.ts' })
    ]
    const result = recentQuickOpenPaths({
      mruOpenFileIds: files.map((f) => f.id),
      openFiles: files,
      recentlyClosed: [],
      activeWorktreeId: WT,
      activeFileId: null
    })
    expect(result).toEqual(['real.ts'])
  })

  it('caps at the limit and returns nothing without an active worktree', () => {
    const many = Array.from({ length: 15 }, (_, i) => openFile({ relativePath: `f${i}.ts` }))
    expect(
      recentQuickOpenPaths({
        mruOpenFileIds: many.map((f) => f.id),
        openFiles: many,
        recentlyClosed: [],
        activeWorktreeId: WT,
        activeFileId: null
      })
    ).toHaveLength(10)
    expect(
      recentQuickOpenPaths({
        mruOpenFileIds: [],
        openFiles: many,
        recentlyClosed: [],
        activeWorktreeId: null,
        activeFileId: null
      })
    ).toEqual([])
  })
})

describe('orderQuickOpenByRecency', () => {
  it('puts recents first, then the rest of the listing without duplicating them', () => {
    const result = orderQuickOpenByRecency(['b.ts', 'a.ts'], ['a.ts', 'b.ts', 'c.ts', 'd.ts'], 10)
    expect(result).toEqual(['b.ts', 'a.ts', 'c.ts', 'd.ts'])
  })

  it('honours the limit across recents + rest', () => {
    const result = orderQuickOpenByRecency(['b.ts', 'a.ts'], ['c.ts', 'd.ts', 'e.ts'], 3)
    expect(result).toEqual(['b.ts', 'a.ts', 'c.ts'])
  })
})
