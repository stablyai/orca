// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { useWorktreeFiles } from './use-worktree-files'

const ACTIVE_WORKTREE_ID = 'wt-active'
const OTHER_WORKTREE_ID = 'wt-other'
type WorktreeFilesProps = { openFiles: OpenFile[]; worktreeId: string | null }

function installFilterReadCounter(files: OpenFile[], worktreeIdReads: { value: number }): void {
  const filter = files.filter.bind(files)
  Object.defineProperty(files, 'filter', {
    configurable: true,
    value: (predicate: (file: OpenFile, index: number, array: OpenFile[]) => unknown): OpenFile[] =>
      filter((file, index, array) => {
        worktreeIdReads.value += 1
        return predicate(file, index, array)
      })
  })
}

function makeCountedOpenFiles(count: number): {
  files: OpenFile[]
  worktreeIdReads: { value: number }
} {
  const worktreeIdReads = { value: 0 }
  const files = Array.from({ length: count }, (_, index) => {
    const worktreeId = index % 2 === 0 ? ACTIVE_WORKTREE_ID : OTHER_WORKTREE_ID
    return {
      id: `file-${index}`,
      filePath: `/repo/${index}.ts`,
      relativePath: `${index}.ts`,
      language: 'typescript',
      isDirty: false,
      mode: 'edit',
      worktreeId
    } as OpenFile
  })
  installFilterReadCounter(files, worktreeIdReads)
  return { files, worktreeIdReads }
}

afterEach(cleanup)

describe('useWorktreeFiles', () => {
  it('does not rescan stable open files across 100 unchanged renders', () => {
    const { files, worktreeIdReads } = makeCountedOpenFiles(10_000)
    const view = renderHook<OpenFile[], WorktreeFilesProps>(
      ({ openFiles, worktreeId }: WorktreeFilesProps) => useWorktreeFiles(openFiles, worktreeId),
      {
        initialProps: {
          openFiles: files,
          worktreeId: ACTIVE_WORKTREE_ID
        } satisfies WorktreeFilesProps
      }
    )
    const first = view.result.current

    expect(first).toHaveLength(5_000)
    expect(worktreeIdReads.value).toBe(10_000)

    for (let render = 0; render < 100; render += 1) {
      view.rerender({ openFiles: files, worktreeId: ACTIVE_WORKTREE_ID })
    }

    expect(view.result.current).toBe(first)
    expect(worktreeIdReads.value).toBe(10_000)
  })

  it('recomputes when the open-file array or rendered worktree changes', () => {
    const { files, worktreeIdReads } = makeCountedOpenFiles(10)
    const view = renderHook<OpenFile[], WorktreeFilesProps>(
      ({ openFiles, worktreeId }: WorktreeFilesProps) => useWorktreeFiles(openFiles, worktreeId),
      {
        initialProps: {
          openFiles: files,
          worktreeId: ACTIVE_WORKTREE_ID
        } satisfies WorktreeFilesProps
      }
    )
    const first = view.result.current
    expect(first).toHaveLength(5)
    expect(worktreeIdReads.value).toBe(10)

    const replacementFiles = [...files]
    installFilterReadCounter(replacementFiles, worktreeIdReads)
    view.rerender({ openFiles: replacementFiles, worktreeId: ACTIVE_WORKTREE_ID })
    const replacement = view.result.current
    expect(replacement).not.toBe(first)
    expect(replacement).toHaveLength(5)
    expect(worktreeIdReads.value).toBe(20)

    view.rerender({ openFiles: replacementFiles, worktreeId: OTHER_WORKTREE_ID })
    expect(view.result.current).toHaveLength(5)
    expect(view.result.current).not.toBe(replacement)
    expect(worktreeIdReads.value).toBe(30)

    view.rerender({ openFiles: replacementFiles, worktreeId: null })
    expect(view.result.current).toEqual([])
    expect(worktreeIdReads.value).toBe(30)
  })
})
