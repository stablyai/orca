// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { useEditorPanelDiffContentLoader } from './useEditorPanelDiffContentLoader'

const { stat, readDiff } = vi.hoisted(() => ({ stat: vi.fn(), readDiff: vi.fn() }))
vi.mock('@/runtime/files/metadata/runtime-file-metadata-client', () => ({
  statRuntimePath: stat,
  isMissingRuntimePathError: () => false
}))
vi.mock('@/runtime/source-control/git/runtime-git-diff-client', () => ({
  getRuntimeGitDiff: readDiff
}))
vi.mock('@/lib/editor/file-operations/editor-file-operation-owner', () => ({
  getEditorFileReadContext: () => ({ target: { kind: 'local' } })
}))
vi.mock('@/runtime/source-control/git/runtime-git-client-context', () => ({
  getRuntimeGitScope: () => undefined
}))

it('shares a diff snapshot when same-tick callers wait for file metadata', async () => {
  let finishStat!: (value: { mtime: number }) => void
  stat
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishStat = resolve
      })
    )
    .mockResolvedValue({ mtime: 123 })
  readDiff.mockResolvedValue({
    kind: 'text',
    originalContent: 'before',
    modifiedContent: 'after',
    originalIsBinary: false,
    modifiedIsBinary: false
  })
  const setDiffContents = vi.fn()
  const { result } = renderHook(() =>
    useEditorPanelDiffContentLoader({
      diffReadGenerationCounterRef: { current: 0 },
      diffReadGenerationRef: { current: {} },
      outstandingDiffReadsRef: { current: {} },
      setDiffContents
    })
  )
  const file: OpenFile = {
    id: 'dedup',
    worktreeId: 'wt',
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    mode: 'diff',
    diffSource: 'staged',
    language: 'typescript',
    isDirty: false
  }
  await act(async () => {
    const first = result.current(file)
    const second = result.current({ ...file, id: 'dedup-other-tab' })
    finishStat({ mtime: 123 })
    await Promise.all([first, second])
  })
  expect(readDiff).toHaveBeenCalledTimes(1)
  expect(setDiffContents).toHaveBeenCalled()
})
