import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import {
  isReloadableSingleFileDiffTab,
  shouldReloadDiffOnGitStatusChange
} from './editor-panel-diff-reload'
import type { GitStatusEntry } from '../../../../shared/types'

function makeDiffFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: 'wt-1::diff::unstaged::file.ts',
    filePath: '/repo/file.ts',
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'diff',
    diffSource: 'unstaged',
    ...overrides
  }
}

describe('editor-panel-diff-reload helpers', () => {
  it('treats single-file diff tabs as reloadable', () => {
    expect(isReloadableSingleFileDiffTab(makeDiffFile())).toBe(true)
    expect(isReloadableSingleFileDiffTab(makeDiffFile({ diffSource: 'staged' }))).toBe(true)
    expect(isReloadableSingleFileDiffTab(makeDiffFile({ diffSource: 'branch' }))).toBe(true)
    expect(
      isReloadableSingleFileDiffTab(makeDiffFile({ diffSource: 'combined-uncommitted' }))
    ).toBe(false)
  })

  it('reloads unstaged and staged diff tabs when git status changes', () => {
    expect(shouldReloadDiffOnGitStatusChange(makeDiffFile())).toBe(true)
    expect(shouldReloadDiffOnGitStatusChange(makeDiffFile({ diffSource: 'staged' }))).toBe(true)
    expect(shouldReloadDiffOnGitStatusChange(makeDiffFile({ diffSource: 'branch' }))).toBe(false)
    expect(shouldReloadDiffOnGitStatusChange(makeDiffFile({ mode: 'edit' }))).toBe(false)
  })

  it('keeps an unstaged diff snapshot when the row moves to staged', () => {
    const entries: GitStatusEntry[] = [{ path: 'file.ts', status: 'modified', area: 'staged' }]

    expect(shouldReloadDiffOnGitStatusChange(makeDiffFile(), entries)).toBe(false)
  })

  it('keeps a staged diff snapshot when the row is committed', () => {
    expect(shouldReloadDiffOnGitStatusChange(makeDiffFile({ diffSource: 'staged' }), [])).toBe(
      false
    )
  })

  it('reloads a diff when its own status row is still present', () => {
    expect(
      shouldReloadDiffOnGitStatusChange(makeDiffFile(), [
        { path: 'file.ts', status: 'modified', area: 'unstaged' }
      ])
    ).toBe(true)
    expect(
      shouldReloadDiffOnGitStatusChange(makeDiffFile(), [
        { path: 'file.ts', status: 'untracked', area: 'untracked' }
      ])
    ).toBe(true)
    expect(
      shouldReloadDiffOnGitStatusChange(makeDiffFile({ diffSource: 'staged' }), [
        { path: 'file.ts', status: 'modified', area: 'staged' }
      ])
    ).toBe(true)
  })
})
