// @vitest-environment happy-dom

import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import {
  useEditorPanelDiffContentLoader,
  type EditorPanelDiffContentLoader
} from './useEditorPanelDiffContentLoader'

const calls = vi.hoisted(() => ({ getDiff: vi.fn(), setDiffContents: vi.fn() }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ settings: null }) } }))
vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitDiff: calls.getDiff,
  getRuntimeGitScope: () => null,
  getRuntimeGitBranchDiff: vi.fn(),
  getRuntimeGitCommitDiff: vi.fn()
}))

describe('editable Changes index baseline', () => {
  it.each([true, false])('selects the requested baseline (index=%s)', async (index) => {
    calls.getDiff.mockClear()
    calls.getDiff.mockResolvedValue({
      kind: 'text',
      originalContent: 'original',
      modifiedContent: 'working',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
    const file: OpenFile = {
      id: '/repo/readme.md',
      filePath: '/repo/readme.md',
      relativePath: 'readme.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit',
      isDirty: false,
      changesAgainstIndex: index
    }
    let load: EditorPanelDiffContentLoader = async () => {}
    function Probe(): null {
      load = useEditorPanelDiffContentLoader({
        diffReadGenerationCounterRef: useRef(0),
        diffReadGenerationRef: useRef({}),
        outstandingDiffReadsRef: useRef({}),
        setDiffContents: calls.setDiffContents
      })
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<Probe />))
      await load(file)
      expect(calls.getDiff).toHaveBeenCalledWith(expect.anything(), {
        filePath: file.relativePath,
        staged: false,
        compareAgainstHead: !index
      })
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})
