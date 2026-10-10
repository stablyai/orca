// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { DiffContent } from './editor-panel-content-types'
import { useEditorPanelDiffContentLoader } from './useEditorPanelDiffContentLoader'

const mocks = vi.hoisted(() => ({ diff: vi.fn() }))
vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitDiff: mocks.diff,
  getRuntimeGitBranchDiff: vi.fn(),
  getRuntimeGitCommitDiff: vi.fn(),
  getRuntimeGitScope: () => null
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ settings: null }) } }))

const file: OpenFile = {
  id: 'diff-file',
  filePath: '/repo/file.ts',
  relativePath: 'file.ts',
  worktreeId: 'wt-1',
  language: 'typescript',
  mode: 'diff',
  diffSource: 'unstaged',
  isDirty: false
}

afterEach(() => {
  cleanup()
  mocks.diff.mockReset()
})

describe('diff loader error content', () => {
  it('marks a failed read and clears the marker after successful reload', async () => {
    mocks.diff.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce({
      kind: 'text',
      originalContent: 'original',
      modifiedContent: 'real file content',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
    const hook = renderHook(() => {
      const [diffs, setDiffContents] = useState<Record<string, DiffContent>>({})
      const load = useEditorPanelDiffContentLoader({
        diffReadGenerationCounterRef: useRef(0),
        diffReadGenerationRef: useRef({}),
        outstandingDiffReadsRef: useRef({}),
        setDiffContents
      })
      return { diffs, load }
    })
    await act(() => hook.result.current.load(file))
    expect(hook.result.current.diffs[file.id]?.modifiedContent).toContain('connection lost')
    expect(hook.result.current.diffs[file.id]?.loadError).toBe(true)
    await act(() => hook.result.current.load(file, { force: true }))
    expect(hook.result.current.diffs[file.id]?.modifiedContent).toBe('real file content')
    expect(hook.result.current.diffs[file.id]?.loadError).toBeUndefined()
  })
})
