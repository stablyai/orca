import { describe, expect, it } from 'vitest'
import { getEditorHeaderCopyState, getEditorHeaderOpenFileState } from './editor-header'
import type { OpenFile } from '@/store/slices/editor'

function makeOpenFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/file.ts',
    filePath: '/repo/file.ts',
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

describe('getEditorHeaderCopyState', () => {
  it('shows the check name without a copyable path for check-details tabs', () => {
    expect(
      getEditorHeaderCopyState(
        makeOpenFile({
          id: 'wt-1::check-details::check-run:99',
          filePath: 'wt-1::check-details::check-run:99',
          relativePath: 'verify',
          mode: 'check-details',
          checkRunDetails: {
            contextKey: 'repo:42',
            check: {
              name: 'verify',
              status: 'completed',
              conclusion: 'failure',
              url: null,
              checkRunId: 99
            },
            details: null,
            loading: false,
            error: null
          }
        })
      )
    ).toEqual({
      copyText: null,
      copyToastLabel: 'Check details copied',
      pathLabel: 'verify',
      pathTitle: 'verify'
    })
  })
})

describe('getEditorHeaderOpenFileState', () => {
  it('disables opening the file when the uncommitted diff is deleted', () => {
    expect(
      getEditorHeaderOpenFileState(
        makeOpenFile({
          id: 'wt-1::diff::unstaged::file.ts',
          mode: 'diff',
          diffSource: 'unstaged'
        }),
        { path: 'file.ts', status: 'deleted', area: 'unstaged' }
      )
    ).toEqual({ canOpen: false })
  })

  it('disables opening the file when the branch diff target is deleted', () => {
    expect(
      getEditorHeaderOpenFileState(
        makeOpenFile({
          id: 'wt-1::diff::branch::main::v1::file.ts',
          mode: 'diff',
          diffSource: 'branch'
        }),
        null,
        { path: 'file.ts', status: 'deleted' }
      )
    ).toEqual({ canOpen: false })
  })

  it('keeps branch diff open enabled when the live compare entry is gone', () => {
    expect(
      getEditorHeaderOpenFileState(
        makeOpenFile({
          id: 'wt-1::diff::branch::main::v1::file.ts',
          mode: 'diff',
          diffSource: 'branch'
        }),
        null,
        null
      )
    ).toEqual({ canOpen: true })
  })

  it('keeps the action enabled when live uncommitted metadata has already disappeared', () => {
    expect(
      getEditorHeaderOpenFileState(
        makeOpenFile({
          id: 'wt-1::diff::unstaged::file.ts',
          mode: 'diff',
          diffSource: 'unstaged'
        }),
        null
      )
    ).toEqual({ canOpen: true })
  })
})
