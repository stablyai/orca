import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { getOpenFilesForExternalFileChange } from './editor-autosave'
import { indexEditorExternalWatchBatchPaths } from './editor-external-watch-path-index'

function tab(filePath: string, overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: 'editor',
    filePath,
    relativePath: 'src/File.ts',
    worktreeId: 'workspace',
    mode: 'edit',
    language: 'typescript',
    isDirty: false,
    ...overrides
  }
}

function matching(
  root: string,
  file: OpenFile,
  absolutePath: string,
  relativePath: string,
  runtimeEnvironmentId: string | null = null
): OpenFile[][] {
  const target = { worktreeId: 'workspace', worktreePath: root, runtimeEnvironmentId }
  const index = indexEditorExternalWatchBatchPaths(
    { worktreePath: root, events: [{ kind: 'update', absolutePath }] },
    [file],
    target
  )
  expect(index.changes).toHaveLength(1)
  return [
    index.matchingOpenFiles(index.changes[0]),
    getOpenFilesForExternalFileChange([file], { ...target, relativePath })
  ]
}

describe('external editor updates across Windows path spellings', () => {
  it.each([
    ['C:/Repo', 'c:\\repo\\src\\file.ts', 'C:/Repo/src/File.ts'],
    ['c:\\repo', 'C:/Repo/src/File.ts', 'c:\\repo\\src\\file.ts'],
    [
      '\\\\Server\\Share\\Repo',
      '//server/share/repo/src/file.ts',
      '\\\\Server\\Share\\Repo\\src\\File.ts'
    ]
  ])('matches the same file under %s in both notification paths', (root, filePath, changedPath) => {
    const file = tab(filePath)
    for (const result of matching(root, file, changedPath, 'src/File.ts')) {
      expect(result).toEqual([file])
    }
  })

  it.each(['edit', 'markdown-preview'] as const)(
    'matches %s tabs without changing their paths',
    (mode) => {
      const file = tab('C:/Repo/src/File.ts', { mode })
      for (const result of matching('c:\\repo', file, 'c:\\repo\\src\\file.ts', 'src/file.ts')) {
        expect(result).toEqual([file])
      }
      expect(file.filePath).toBe('C:/Repo/src/File.ts')
      expect(file.relativePath).toBe('src/File.ts')
    }
  )

  it('preserves runtime ownership for Windows paths', () => {
    const file = tab('C:/Repo/src/File.ts', { runtimeEnvironmentId: 'remote-windows' })
    for (const result of matching('c:/repo', file, 'c:/repo/src/file.ts', 'src/file.ts')) {
      expect(result).toEqual([])
    }
    for (const result of matching(
      'c:/repo',
      file,
      'c:/repo/src/file.ts',
      'src/file.ts',
      'remote-windows'
    )) {
      expect(result).toEqual([file])
    }
  })

  it('rejects another workspace even with the same Windows path', () => {
    const file = tab('C:/Repo/src/File.ts', { worktreeId: 'other' })
    for (const result of matching('c:/repo', file, 'c:/repo/src/file.ts', 'src/file.ts')) {
      expect(result).toEqual([])
    }
  })

  it('rejects a different filename under a Windows root', () => {
    const file = tab('C:/Repo/src/File.ts')
    for (const result of matching('c:/repo', file, 'c:/repo/src/other.ts', 'src/other.ts')) {
      expect(result).toEqual([])
    }
  })

  it('matches a fallback notification without the optional runtime owner field', () => {
    const file = tab('C:\\Repo\\src\\File.ts')
    expect(
      getOpenFilesForExternalFileChange([file], {
        worktreeId: 'workspace',
        worktreePath: 'c:/repo',
        relativePath: 'src/file.ts'
      })
    ).toEqual([file])
  })

  it.each([
    ['/srv/repo', '/srv/repo/src/File.ts', '/srv/repo/src/file.ts'],
    [
      '\\\\wsl.localhost\\Ubuntu\\repo',
      '\\\\wsl.localhost\\Ubuntu\\repo\\src\\File.ts',
      '\\\\wsl.localhost\\Ubuntu\\repo\\src\\file.ts'
    ],
    ['/srv/repo', '/srv/repo/src\\File.ts', '/srv/repo/src/File.ts'],
    ['/srv/repo', '/srv/repo/src/é.ts', '/srv/repo/src/é.ts']
  ])('keeps distinct case-sensitive paths under %s separate', (root, filePath, changedPath) => {
    const file = tab(filePath)
    const relativePath = changedPath.slice(root.length + 1)
    for (const result of matching(root, file, changedPath, relativePath)) {
      expect(result).toEqual([])
    }
  })
})
