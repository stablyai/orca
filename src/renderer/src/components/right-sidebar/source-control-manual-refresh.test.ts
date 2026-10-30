import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import {
  applyManualSourceControlDiffReload,
  isManualRefreshReloadableDiffFile,
  shouldStartManualSourceControlRefresh
} from './source-control-manual-refresh'

function openFile(overrides: Partial<OpenFile>): OpenFile {
  return {
    id: overrides.id ?? 'file',
    filePath: overrides.filePath ?? '/repo/file.ts',
    relativePath: overrides.relativePath ?? 'file.ts',
    worktreeId: overrides.worktreeId ?? 'wt-1',
    language: overrides.language ?? 'typescript',
    isDirty: overrides.isDirty ?? false,
    mode: overrides.mode ?? 'diff',
    ...overrides
  }
}

describe('source-control-manual-refresh', () => {
  it('blocks concurrent manual refreshes while one is in flight', () => {
    expect(shouldStartManualSourceControlRefresh(false)).toBe(true)
    expect(shouldStartManualSourceControlRefresh(true)).toBe(false)
  })

  it('reloads only staged/unstaged single-file diffs for the active worktree', () => {
    expect(
      isManualRefreshReloadableDiffFile(
        openFile({ worktreeId: 'wt-1', mode: 'diff', diffSource: 'unstaged' }),
        'wt-1'
      )
    ).toBe(true)
    expect(
      isManualRefreshReloadableDiffFile(
        openFile({ worktreeId: 'wt-1', mode: 'diff', diffSource: 'staged' }),
        'wt-1'
      )
    ).toBe(true)
    expect(
      isManualRefreshReloadableDiffFile(
        openFile({ worktreeId: 'wt-2', mode: 'diff', diffSource: 'unstaged' }),
        'wt-1'
      )
    ).toBe(false)
    expect(
      isManualRefreshReloadableDiffFile(
        openFile({ worktreeId: 'wt-1', mode: 'diff', diffSource: 'branch' }),
        'wt-1'
      )
    ).toBe(false)
    expect(
      isManualRefreshReloadableDiffFile(
        openFile({ worktreeId: 'wt-1', mode: 'edit', diffSource: undefined }),
        'wt-1'
      )
    ).toBe(false)
  })

  it('reloads edit-mode tabs that are actively displaying Changes', () => {
    const editChanges = openFile({
      id: '/repo/readme.md',
      worktreeId: 'wt-1',
      mode: 'edit'
    })
    expect(
      isManualRefreshReloadableDiffFile(editChanges, 'wt-1', {
        '/repo/readme.md': 'changes'
      })
    ).toBe(true)
    expect(isManualRefreshReloadableDiffFile(editChanges, 'wt-1', {})).toBe(false)
    expect(
      isManualRefreshReloadableDiffFile(editChanges, 'wt-1', {
        '/repo/readme.md': 'edit'
      })
    ).toBe(false)
    expect(
      isManualRefreshReloadableDiffFile(
        openFile({ id: '/repo/other.md', worktreeId: 'wt-1', mode: 'edit' }),
        'wt-1',
        { '/repo/readme.md': 'changes' }
      )
    ).toBe(false)
  })

  it('bumps diffContentReloadNonce only for matching open diffs', () => {
    const files = [
      openFile({
        id: 'unstaged',
        worktreeId: 'wt-1',
        mode: 'diff',
        diffSource: 'unstaged',
        diffContentReloadNonce: 2
      }),
      openFile({
        id: 'staged',
        worktreeId: 'wt-1',
        mode: 'diff',
        diffSource: 'staged'
      }),
      openFile({
        id: 'other-wt',
        worktreeId: 'wt-2',
        mode: 'diff',
        diffSource: 'unstaged',
        diffContentReloadNonce: 4
      }),
      openFile({
        id: 'branch',
        worktreeId: 'wt-1',
        mode: 'diff',
        diffSource: 'branch'
      }),
      openFile({
        id: 'edit',
        worktreeId: 'wt-1',
        mode: 'edit'
      }),
      openFile({
        id: '/repo/readme.md',
        worktreeId: 'wt-1',
        mode: 'edit',
        diffContentReloadNonce: 1
      })
    ]

    const next = applyManualSourceControlDiffReload(files, 'wt-1', {
      '/repo/readme.md': 'changes'
    })

    expect(next[0]?.diffContentReloadNonce).toBe(3)
    expect(next[1]?.diffContentReloadNonce).toBe(1)
    expect(next[2]?.diffContentReloadNonce).toBe(4)
    expect(next[3]?.diffContentReloadNonce).toBeUndefined()
    expect(next[4]?.diffContentReloadNonce).toBeUndefined()
    expect(next[5]?.diffContentReloadNonce).toBe(2)
    expect(next).not.toBe(files)
  })

  it('returns the same array when no open diffs need a reload', () => {
    const files = [
      openFile({ id: 'edit', worktreeId: 'wt-1', mode: 'edit' }),
      openFile({ id: 'branch', worktreeId: 'wt-1', mode: 'diff', diffSource: 'branch' })
    ]
    expect(applyManualSourceControlDiffReload(files, 'wt-1', { edit: 'edit' })).toBe(files)
  })
})
