import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
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
  it('matches UNC aliases for updates, deletes, and restored tombstones', () => {
    const restored = file({
      id: 'restored',
      filePath: '//wsl.localhost/Ubuntu/workspace/repo/file.ts',
      externalMutation: 'deleted'
    })
    const index = indexEditorExternalWatchBatchPaths(
      {
        worktreePath: wslScope.worktreePath,
        events: [
          {
            kind: 'delete',
            absolutePath: '\\\\wsl$\\Ubuntu\\workspace\\repo\\file.ts'
          },
          {
            kind: 'create',
            absolutePath: '\\\\wsl.localhost\\Ubuntu\\workspace\\repo\\file.ts'
          }
        ]
      },
      [restored],
      wslScope
    )

    expect(index.deletedOpenEditors).toEqual([
      {
        file: restored,
        normalizedDeletePath: '//wsl/ubuntu/workspace/repo/file.ts'
      }
    ])
    expect(index.matchesCreateOrUpdate(restored)).toBe(true)
    expect(index.matchingOpenFiles(index.changes[0])).toEqual([restored])
  })

  it('matches /mnt drive aliases without folding WSL filesystem case', () => {
    const mounted = file({
      id: 'mounted',
      filePath: '//wsl.localhost/Ubuntu/mnt/c/Repo/File.ts'
    })
    const nativeScope = { ...wslScope, worktreePath: 'C:\\Repo' }
    const matching = indexEditorExternalWatchBatchPaths(
      {
        worktreePath: nativeScope.worktreePath,
        events: [{ kind: 'update', absolutePath: 'c:\\repo\\file.ts' }]
      },
      [mounted],
      nativeScope
    )
    const wrongLinuxCase = indexEditorExternalWatchBatchPaths(
      {
        worktreePath: nativeScope.worktreePath,
        events: [{ kind: 'update', absolutePath: 'C:\\Repo\\File.ts' }]
      },
      [
        file({
          id: 'linux-case',
          filePath: '//wsl.localhost/Ubuntu/home/Alice/File.ts'
        })
      ],
      nativeScope
    )

    expect(matching.matchingOpenFiles(matching.changes[0])).toEqual([mounted])
    expect(wrongLinuxCase.matchingOpenFiles(wrongLinuxCase.changes[0])).toEqual([])
  })

  it('keeps aliases literal for SSH, runtimes, and POSIX scopes', () => {
    const restored = file({
      id: 'restored',
      filePath: '//wsl.localhost/Ubuntu/workspace/repo/file.ts'
    })
    const payload = {
      worktreePath: wslScope.worktreePath,
      events: [
        {
          kind: 'update' as const,
          absolutePath: '\\\\wsl.localhost\\Ubuntu\\workspace\\repo\\file.ts'
        }
      ]
    }

    for (const scope of [
      { ...wslScope, allowLocalWindowsWslAliases: undefined },
      { ...wslScope, runtimeEnvironmentId: 'env-1', allowLocalWindowsWslAliases: undefined }
    ]) {
      const index = indexEditorExternalWatchBatchPaths(payload, [restored], scope)
      expect(index.matchingOpenFiles(index.changes[0])).toEqual([])
    }

    const posix = indexEditorExternalWatchBatchPaths(
      {
        worktreePath: '/srv/repo',
        events: [{ kind: 'update', absolutePath: '/srv/repo/file.ts' }]
      },
      [restored],
      {
        ...wslScope,
        worktreePath: '/srv/repo',
        allowLocalWindowsWslAliases: undefined
      }
    )
    expect(posix.matchingOpenFiles(posix.changes[0])).toEqual([])
  })

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
