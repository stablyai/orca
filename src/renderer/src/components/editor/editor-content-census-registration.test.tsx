// @vitest-environment happy-dom

/**
 * Why through the real hook rather than the census module's own suite: the census is
 * only true if useEditorPanelContentState registers it and keeps its ref current. A
 * fake reader proves the profile plumbing and nothing about the number that reaches
 * an OOM report — stripping the registration or freezing the ref is otherwise green.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

const mocks = vi.hoisted(() => ({
  readRuntimeFileContent: vi.fn(),
  getState: vi.fn()
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  getRuntimeFileReadScope: vi.fn(() => null),
  readRuntimeFileContent: mocks.readRuntimeFileContent,
  subscribeRuntimeFileChanges: vi.fn()
}))

vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitBranchDiff: vi.fn(),
  getRuntimeGitCommitDiff: vi.fn(),
  getRuntimeGitDiff: vi.fn(),
  getRuntimeGitScope: vi.fn(() => null)
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(),
  getConnectionIdForFile: vi.fn(),
  isWorktreeConnectionResolved: vi.fn(() => true)
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState }
}))

import { useEditorPanelContentState } from './useEditorPanelContentState'
import { resetEditorContentCensusForTesting } from './editor-content-memory-census'
import { collectRendererMemoryProfileCounts } from '@/lib/renderer-memory-profile'

const activeFile: OpenFile = {
  id: '/repo/file.ts',
  filePath: '/repo/file.ts',
  relativePath: 'file.ts',
  worktreeId: 'wt-1',
  language: 'typescript',
  isDirty: false,
  mode: 'edit'
}

// Why hoisted: a fresh array literal per render re-arms the hook's load effect forever.
const openFiles = [activeFile]

let loadedContent = ''

function HookProbe(): null {
  const state = useEditorPanelContentState({
    activeFile,
    isChangesMode: false,
    openFiles,
    gitStatusEntries: undefined,
    editorViewMode: {}
  })
  loadedContent = state.fileContents[activeFile.id]?.content ?? ''
  return null
}

describe('editor content census registration', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    loadedContent = ''
    resetEditorContentCensusForTesting()
    ;(window as unknown as { api: unknown }).api = {
      fs: { authorizeExternalPath: vi.fn(), onLocalLogTailChanged: vi.fn(() => () => {}) }
    }
    mocks.readRuntimeFileContent.mockReset()
    mocks.getState.mockReset()
    mocks.getState.mockReturnValue({
      settings: null,
      openFiles: [],
      setLastKnownDiskSignature: vi.fn()
    })
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    container = null
    root = null
    resetEditorContentCensusForTesting()
  })

  it('reports the loaded file body to the memory profile, and stops on unmount', async () => {
    const content = 'x'.repeat(4_096)
    mocks.readRuntimeFileContent.mockResolvedValue({ content, isBinary: false })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<HookProbe />)
    })

    await vi.waitFor(() => expect(loadedContent).toBe(content))
    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'editorContent.panels': 1,
      'editorContent.files': 1,
      'editorContent.chars': 4_096,
      'editorContent.droppedPanels': 0
    })

    act(() => root?.unmount())
    root = null
    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'editorContent.panels': 0,
      'editorContent.chars': 0
    })
  })
})
