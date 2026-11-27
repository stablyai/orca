// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { getRuntimeGitDiff } from '@/runtime/source-control/git/runtime-git-diff-client'
import { stampCleanTabDiskBaseline } from '../external-changes/editor-clean-tab-disk-baseline'
import type { DiffContent } from './editor-panel-content-types'
import { useEditorPanelDiffContentLoader } from './useEditorPanelDiffContentLoader'

const editorDrafts = vi.hoisted((): Record<string, string> => ({}))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({ editorDrafts }) } }))
vi.mock('@/lib/editor/file-operations/editor-file-operation-owner', () => ({
  getEditorFileReadContext: () => ({ target: { kind: 'local' } })
}))
vi.mock('@/runtime/source-control/git/runtime-git-diff-client', () => ({
  getRuntimeGitDiff: vi.fn()
}))
vi.mock('../external-changes/editor-clean-tab-disk-baseline', () => ({
  stampCleanTabDiskBaseline: vi.fn()
}))

afterEach(cleanup)

it('keeps a failed switch back to UTF-8 out of the editable contents and retries the read', async () => {
  const file: OpenFile = {
    id: 'diff',
    worktreeId: 'wt',
    filePath: '/repo/file.txt',
    relativePath: 'file.txt',
    mode: 'diff',
    diffSource: 'unstaged',
    language: 'plaintext',
    isDirty: false
  }
  const text = {
    kind: 'text',
    originalContent: '',
    modifiedContent: '中文',
    originalIsBinary: false,
    modifiedIsBinary: false
  } as const
  vi.mocked(getRuntimeGitDiff)
    .mockResolvedValueOnce({ ...text, encoding: 'gb18030' })
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockResolvedValueOnce({ ...text, modifiedContent: 'restored' })

  const { result } = renderHook(() => {
    const [contents, setDiffContents] = useState<Record<string, DiffContent>>({})
    const load = useEditorPanelDiffContentLoader({
      diffReadGenerationCounterRef: useRef(0),
      diffReadGenerationRef: useRef({}),
      outstandingDiffReadsRef: useRef({}),
      setDiffContents
    })
    return { contents, load }
  })
  await act(() => result.current.load({ ...file, diffEncoding: 'gb18030' }))
  expect(result.current.contents.diff.modifiedContent).toBe('中文')
  await act(() => result.current.load(file))
  expect(result.current.contents.diff.loadError).toContain('connection lost')
  expect(result.current.contents.diff.modifiedContent).toBe('')
  expect(stampCleanTabDiskBaseline).not.toHaveBeenCalled()

  await act(() => result.current.load(file, { force: true, wakeWslDistro: true }))
  expect(result.current.contents.diff).toMatchObject({ modifiedContent: 'restored' })
  expect(result.current.contents.diff.loadError).toBeUndefined()
  expect(stampCleanTabDiskBaseline).toHaveBeenCalledWith(file.id, {
    content: 'restored',
    isBinary: false
  })

  editorDrafts[file.id] = 'my unsaved edit'
  vi.mocked(getRuntimeGitDiff).mockRejectedValueOnce(new Error('background read failed'))
  await act(() => result.current.load(file))
  expect(result.current.contents.diff.modifiedContent).toBe('restored')
  expect(result.current.contents.diff.loadError).toBeUndefined()
  expect(stampCleanTabDiskBaseline).toHaveBeenCalledTimes(1)
})
