// @vitest-environment happy-dom
// Why: separate file because useEditorPanelContentState.test.tsx already sits at the 800-line cap.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { DiffContent } from './editor-panel-content-types'

const mocks = vi.hoisted(() => ({
  readRuntimeFileContent: vi.fn(),
  getRuntimeGitDiff: vi.fn(),
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
  getRuntimeGitDiff: mocks.getRuntimeGitDiff,
  getRuntimeGitScope: vi.fn(() => null)
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => undefined),
  getConnectionIdForFile: vi.fn(() => undefined),
  isWorktreeConnectionResolved: vi.fn(() => true)
}))

vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: vi.fn(() => null)
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState }
}))

import { useEditorPanelContentState } from './useEditorPanelContentState'

let latestDiffContents: Record<string, DiffContent> = {}
let latestReloadContent: (file: OpenFile) => void = () => {}

const DIFF_FILE: OpenFile = {
  id: 'wt-1::diff::unstaged::file.ts',
  filePath: '/repo/file.ts',
  relativePath: 'file.ts',
  worktreeId: 'wt-1',
  language: 'typescript',
  isDirty: false,
  mode: 'diff',
  diffSource: 'unstaged'
}

// Why: stable identities — a fresh openFiles array each render re-arms the load effect forever.
const OPEN_FILES = [DIFF_FILE]
const EDITOR_VIEW_MODE = {}

function HookProbe(): null {
  const state = useEditorPanelContentState({
    activeFile: DIFF_FILE,
    isChangesMode: false,
    openFiles: OPEN_FILES,
    gitStatusEntries: undefined,
    editorViewMode: EDITOR_VIEW_MODE
  })
  latestDiffContents = state.diffContents
  latestReloadContent = state.reloadContent
  return null
}

describe('useEditorPanelContentState diff load failures', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    latestDiffContents = {}
    ;(window as unknown as { api: unknown }).api = {
      fs: { authorizeExternalPath: vi.fn(), onLocalLogTailChanged: vi.fn(() => () => {}) }
    }
    mocks.readRuntimeFileContent.mockReset()
    mocks.getRuntimeGitDiff.mockReset()
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
  })

  it('flags a rejected diff fetch, then clears the flag on a successful reload', async () => {
    // Why: the fabricated "Error loading diff: …" body reads as file content; without the flag
    // EditorContent keeps the pane editable and a save writes that sentence over the real file.
    mocks.getRuntimeGitDiff
      .mockRejectedValueOnce(new Error('diff_too_large'))
      .mockResolvedValueOnce({
        kind: 'text',
        originalContent: 'old',
        modifiedContent: 'recovered diff content',
        originalIsBinary: false,
        modifiedIsBinary: false
      })

    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => {
      root?.render(<HookProbe />)
    })

    await vi.waitFor(() => expect(latestDiffContents[DIFF_FILE.id]?.loadError).toBe(true))
    expect(latestDiffContents[DIFF_FILE.id]?.modifiedContent).toContain('diff_too_large')

    await act(async () => {
      latestReloadContent(DIFF_FILE)
    })

    await vi.waitFor(() =>
      expect(latestDiffContents[DIFF_FILE.id]?.modifiedContent).toBe('recovered diff content')
    )
    expect(latestDiffContents[DIFF_FILE.id]?.loadError).not.toBe(true)
  })
})
