import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { indexEditorExternalWatchBatchPaths } from './editor-external-watch-path-index'

const wslScope = {
  worktreeId: 'wt-wsl',
  worktreePath: '\\\\wsl.localhost\\Ubuntu\\workspace\\repo',
  runtimeEnvironmentId: null,
  allowLocalWindowsWslAliases: true as const
}

function file(overrides: Partial<OpenFile> & Pick<OpenFile, 'id' | 'filePath'>): OpenFile {
  return {
    relativePath: 'file.ts',
    worktreeId: 'wt-wsl',
    mode: 'edit',
    isDirty: false,
    content: '',
    language: 'typescript',
    ...overrides
  } as OpenFile
}

describe('editor external watch path batch index', () => {
  it('filters owners and preserves open-file ordering across edit and diff matches', () => {
    const edit = file({ id: 'edit', filePath: 'C:\\Repo\\file.ts' })
    const runtime = file({
      id: 'runtime',
      filePath: 'C:\\Repo\\file.ts',
      runtimeEnvironmentId: 'env-1'
    })
    const diff = file({
      id: 'diff',
      filePath: 'C:\\Repo\\file.ts',
      mode: 'diff',
      diffSource: 'unstaged'
    })
    const index = indexEditorExternalWatchBatchPaths(
      {
        worktreePath: 'C:\\Repo',
        events: [{ kind: 'update', absolutePath: 'c:\\repo\\file.ts' }]
      },
      [diff, runtime, edit],
      { ...wslScope, worktreePath: 'C:\\Repo' }
    )

    expect(index.matchingOpenFiles(index.changes[0]).map(({ id }) => id)).toEqual(['diff', 'edit'])
  })

  it('deduplicates repeated events and detects only working-tree combined diffs', () => {
    const index = indexEditorExternalWatchBatchPaths(
      {
        worktreePath: 'C:\\Repo',
        events: [
          { kind: 'create', absolutePath: 'C:\\Repo\\file.ts' },
          { kind: 'update', absolutePath: 'C:\\Repo\\file.ts' },
          { kind: 'update', absolutePath: 'C:\\Repo\\folder', isDirectory: true }
        ]
      },
      [
        file({
          id: 'combined',
          filePath: 'C:\\Repo',
          mode: 'diff',
          diffSource: 'combined-uncommitted'
        }),
        file({
          id: 'branch',
          filePath: 'C:\\Repo',
          mode: 'diff',
          diffSource: 'combined-branch'
        })
      ],
      { ...wslScope, worktreePath: 'C:\\Repo' }
    )

    expect(index.changes.map(({ relativePath }) => relativePath)).toEqual(['file.ts'])
    expect(index.createOrUpdatePaths.size).toBe(1)
    expect(index.hasCombinedDiffConsumer).toBe(true)
  })
})
