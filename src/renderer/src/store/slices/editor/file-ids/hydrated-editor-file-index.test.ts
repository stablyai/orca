import { describe, expect, it } from 'vitest'
import type { PersistedOpenFile } from '../../../../../../shared/workspace-session-state-types'
import {
  LegacyHydratedEditorFileIndex,
  type LegacyHydratedEditorFile
} from './hydrated-editor-file-ids'
import {
  buildOwnedEditorFileId,
  isEditorFileIdOccupiedByOtherOwner,
  isSameEditorOwner
} from './editor-file-ids'

function persisted(filePath: string, runtimeEnvironmentId: string | null): PersistedOpenFile {
  return {
    filePath,
    runtimeEnvironmentId,
    relativePath: filePath,
    worktreeId: '',
    language: 'text'
  }
}

function referenceId(
  files: LegacyHydratedEditorFile[],
  file: PersistedOpenFile,
  worktreeId: string
) {
  const existing = files.find(
    (prior) =>
      prior.filePath === file.filePath &&
      isSameEditorOwner(prior, worktreeId, file.runtimeEnvironmentId)
  )
  if (existing) {
    return existing.id
  }
  return files.some((prior) =>
    isEditorFileIdOccupiedByOtherOwner(prior, file.filePath, worktreeId, file.runtimeEnvironmentId)
  )
    ? buildOwnedEditorFileId(file.filePath, worktreeId, file.runtimeEnvironmentId)
    : file.filePath
}

describe('legacy hydrated editor file index', () => {
  it('matches the old lookup for mixed owners, first-wins duplicates and ID reservations', () => {
    const index = new LegacyHydratedEditorFileIndex()
    const prior: LegacyHydratedEditorFile[] = []
    const paths = [
      '/same.ts',
      'C:\\work\\same.ts',
      '/other.ts',
      'editor:folder:local:%2Fsame.ts',
      '',
      '/preview.md'
    ]
    const worktrees = ['folder:one', 'wt:two', 'floating-terminals']
    const runtimes = [null, '', ' ', 'local', 'peer', ' peer ', 'a:b', '["a","b"]']
    for (let step = 0; step < 120; step++) {
      for (const filePath of paths) {
        for (const worktreeId of worktrees) {
          for (const runtime of runtimes) {
            const file = persisted(filePath, runtime)
            expect(index.hasOwner(file, worktreeId)).toBe(
              prior.some(
                (row) => row.filePath === filePath && isSameEditorOwner(row, worktreeId, runtime)
              )
            )
            expect(index.resolve(file, worktreeId)).toBe(referenceId(prior, file, worktreeId))
          }
        }
      }
      const row: LegacyHydratedEditorFile = {
        filePath: paths[step % paths.length],
        id: paths[(step * 3) % paths.length],
        worktreeId: worktrees[Math.floor(step / paths.length) % worktrees.length],
        runtimeEnvironmentId: runtimes[Math.floor(step / worktrees.length) % runtimes.length],
        ...(step % 4 === 0 ? { markdownPreviewSourceFileId: '/preview.md' } : {})
      }
      index.add(row)
      prior.push(row)
    }
  })
})
