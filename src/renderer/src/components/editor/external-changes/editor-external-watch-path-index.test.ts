import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { indexEditorExternalWatchBatchPaths } from './editor-external-watch-path-index'

const root = '/repo'
// One name: precomposed as Git reports it (NFC), and decomposed jamo as APFS stores a Finder-made name (NFD).
const composedName = '노트.md'
const decomposedName = composedName.normalize('NFD')

function openFile(overrides: Partial<OpenFile> & Pick<OpenFile, 'id'>): OpenFile {
  return {
    filePath: `${root}/${composedName}`,
    relativePath: composedName,
    worktreeId: 'wt',
    language: 'markdown',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

function matchingIds(files: OpenFile[], changedName: string, worktreePath = root): string[] {
  const absolutePath = `${worktreePath}/${changedName}`
  const index = indexEditorExternalWatchBatchPaths(
    { worktreePath, events: [{ kind: 'update', absolutePath }] },
    files,
    { worktreeId: 'wt', worktreePath, runtimeEnvironmentId: null }
  )
  return index.changes.flatMap((change) => index.matchingOpenFiles(change).map((file) => file.id))
}

describe('indexEditorExternalWatchBatchPaths', () => {
  it('matches clean composed tabs and diffs, but not dirty ones, to a decomposed watcher path', () => {
    const files = [
      openFile({ id: 'clean' }),
      openFile({ id: 'dirty', isDirty: true }),
      openFile({ id: 'diff', mode: 'diff', diffSource: 'unstaged' }),
      openFile({ id: 'dirty-diff', mode: 'diff', diffSource: 'unstaged', isDirty: true })
    ]
    expect(matchingIds(files, decomposedName)).toEqual(['clean', 'diff'])
  })

  it('matches a clean decomposed tab to a composed watcher path', () => {
    const files = [
      openFile({ id: 'clean', filePath: `${root}/${decomposedName}` }),
      openFile({ id: 'dirty', filePath: `${root}/${decomposedName}`, isDirty: true })
    ]
    expect(matchingIds(files, composedName)).toEqual(['clean'])
  })

  it('matches a clean composed tab when the worktree root itself is decomposed', () => {
    const decomposedRoot = `/${decomposedName}`
    const files = [
      openFile({ id: 'clean', filePath: `/${composedName}/a.md`, relativePath: 'a.md' })
    ]
    expect(matchingIds(files, 'a.md', decomposedRoot)).toEqual(['clean'])
  })
})
