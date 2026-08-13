import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import {
  canUseChangesModeForFile,
  isAbsolutePathLike,
  toggleEditorDiffViewMode
} from './editor-panel-file-mode'

function openFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/src/app.ts',
    filePath: '/repo/src/app.ts',
    relativePath: 'src/app.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

describe('isAbsolutePathLike', () => {
  it('detects posix, windows, and unc-style paths', () => {
    expect(isAbsolutePathLike('/repo/file.ts')).toBe(true)
    expect(isAbsolutePathLike('C:\\repo\\file.ts')).toBe(true)
    expect(isAbsolutePathLike('\\\\server\\share\\file.ts')).toBe(true)
    expect(isAbsolutePathLike('src/app.ts')).toBe(false)
  })
})

describe('canUseChangesModeForFile', () => {
  it('allows worktree-relative edit files', () => {
    expect(canUseChangesModeForFile(openFile())).toBe(true)
  })

  it('rejects untitled, diff-mode, and absolute relativePath files', () => {
    expect(canUseChangesModeForFile(openFile({ isUntitled: true }))).toBe(false)
    expect(canUseChangesModeForFile(openFile({ mode: 'diff' }))).toBe(false)
    expect(
      canUseChangesModeForFile(
        openFile({
          relativePath: '/repo/src/app.ts',
          filePath: '/repo/src/app.ts'
        })
      )
    ).toBe(false)
  })
})

describe('toggleEditorDiffViewMode', () => {
  it('returns null when changes mode is unavailable', () => {
    expect(toggleEditorDiffViewMode(undefined, false)).toBeNull()
    expect(toggleEditorDiffViewMode('changes', false)).toBeNull()
    expect(toggleEditorDiffViewMode('edit', false)).toBeNull()
  })

  it('toggles edit ↔ changes when changes mode is available', () => {
    expect(toggleEditorDiffViewMode(undefined, true)).toBe('changes')
    expect(toggleEditorDiffViewMode('edit', true)).toBe('changes')
    expect(toggleEditorDiffViewMode('changes', true)).toBe('edit')
  })
})
