// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { GitStatusEntry } from '../../../../shared/types'
import type { DiffContent, FileContent } from './editor-panel-content-types'

const mocks = vi.hoisted(() => ({
  readRuntimeFileContent: vi.fn(),
  getRuntimeGitDiff: vi.fn(),
  getConnectionId: vi.fn(),
  getConnectionIdForFile: vi.fn(),
  getState: vi.fn()
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  getRuntimeFileReadScope: vi.fn(
    (
      settings: { activeRuntimeEnvironmentId?: string | null } | null | undefined,
      connectionId?: string
    ) => connectionId ?? settings?.activeRuntimeEnvironmentId ?? null
  ),
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
  getConnectionId: mocks.getConnectionId,
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: mocks.getState
  }
}))

import { useEditorPanelContentState } from './useEditorPanelContentState'

type ProbeProps = {
  activeFile: OpenFile
  openFiles: OpenFile[]
  gitStatusByWorktree?: Record<string, GitStatusEntry[]>
}

let latestFileContents: Record<string, FileContent> = {}
let latestDiffContents: Record<string, DiffContent> = {}
const EMPTY_GIT_STATUS_BY_WORKTREE: Record<string, GitStatusEntry[]> = {}

function HookProbe({
  activeFile,
  openFiles,
  gitStatusByWorktree = EMPTY_GIT_STATUS_BY_WORKTREE
}: ProbeProps): null {
  const state = useEditorPanelContentState({
    activeFile,
    isChangesMode: false,
    openFiles,
    gitStatusByWorktree,
    editorViewMode: {}
  })
  latestFileContents = state.fileContents
  latestDiffContents = state.diffContents
  return null
}

function createOpenFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/file.ts',
    filePath: '/repo/file.ts',
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

describe('useEditorPanelContentState', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    latestFileContents = {}
    latestDiffContents = {}
    mocks.readRuntimeFileContent.mockReset()
    mocks.getRuntimeGitDiff.mockReset()
    mocks.getConnectionId.mockReset()
    mocks.getConnectionId.mockReturnValue(undefined)
    mocks.getConnectionIdForFile.mockReset()
    mocks.getConnectionIdForFile.mockReturnValue(undefined)
    mocks.getState.mockReset()
    mocks.getState.mockReturnValue({ settings: null })
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    container = null
    root = null
  })

  it('loads folder workspace files through the path-specific SSH connection', async () => {
    const activeFile = createOpenFile({
      filePath: '/home/neil/platform/api/src/file.ts',
      relativePath: 'api/src/file.ts',
      worktreeId: 'folder:folder-workspace-1'
    })
    mocks.getConnectionIdForFile.mockReturnValue('ssh-1')
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'remote content', isBinary: false })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })

    await vi.waitFor(() =>
      expect(latestFileContents[activeFile.id]?.content).toBe('remote content')
    )
    expect(mocks.getConnectionIdForFile).toHaveBeenCalledWith(
      'folder:folder-workspace-1',
      '/home/neil/platform/api/src/file.ts'
    )
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/home/neil/platform/api/src/file.ts',
        relativePath: 'api/src/file.ts',
        worktreeId: 'folder:folder-workspace-1',
        connectionId: 'ssh-1'
      })
    )
  })

  it('reloads a clean file when its file content reload nonce changes', async () => {
    const activeFile = createOpenFile()
    mocks.readRuntimeFileContent
      .mockResolvedValueOnce({ content: 'old content', isBinary: false })
      .mockResolvedValueOnce({ content: 'fresh content', isBinary: false })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })

    await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.content).toBe('old content'))

    const reloadedFile = { ...activeFile, fileContentReloadNonce: 1 }
    await act(async () => {
      root?.render(<HookProbe activeFile={reloadedFile} openFiles={[reloadedFile]} />)
    })

    await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.content).toBe('fresh content'))
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(2)
    expect(mocks.readRuntimeFileContent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filePath: '/repo/file.ts',
        relativePath: 'file.ts',
        worktreeId: 'wt-1'
      })
    )
  })

  it('keeps a loaded unstaged diff when git status moves the row to staged', async () => {
    const activeFile = createOpenFile({
      id: 'wt-1::diff::unstaged::file.ts',
      mode: 'diff',
      diffSource: 'unstaged'
    })
    mocks.getRuntimeGitDiff.mockResolvedValue({
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'large diff content',
      originalIsBinary: false,
      modifiedIsBinary: false
    })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <HookProbe
          activeFile={activeFile}
          openFiles={[activeFile]}
          gitStatusByWorktree={{
            'wt-1': [{ path: 'file.ts', status: 'modified', area: 'unstaged' }]
          }}
        />
      )
    })

    await vi.waitFor(() =>
      expect(latestDiffContents[activeFile.id]?.modifiedContent).toBe('large diff content')
    )

    await act(async () => {
      root?.render(
        <HookProbe
          activeFile={activeFile}
          openFiles={[activeFile]}
          gitStatusByWorktree={{
            'wt-1': [{ path: 'file.ts', status: 'modified', area: 'staged' }]
          }}
        />
      )
    })

    expect(mocks.getRuntimeGitDiff).toHaveBeenCalledTimes(1)
  })

  it('reloads a loaded unstaged diff when its own status row is still present', async () => {
    const activeFile = createOpenFile({
      id: 'wt-1::diff::unstaged::file.ts',
      mode: 'diff',
      diffSource: 'unstaged'
    })
    mocks.getRuntimeGitDiff
      .mockResolvedValueOnce({
        kind: 'text',
        originalContent: 'old',
        modifiedContent: 'first diff content',
        originalIsBinary: false,
        modifiedIsBinary: false
      })
      .mockResolvedValueOnce({
        kind: 'text',
        originalContent: 'old',
        modifiedContent: 'refreshed diff content',
        originalIsBinary: false,
        modifiedIsBinary: false
      })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })

    await vi.waitFor(() =>
      expect(latestDiffContents[activeFile.id]?.modifiedContent).toBe('first diff content')
    )

    await act(async () => {
      root?.render(
        <HookProbe
          activeFile={activeFile}
          openFiles={[activeFile]}
          gitStatusByWorktree={{
            'wt-1': [{ path: 'file.ts', status: 'modified', area: 'unstaged' }]
          }}
        />
      )
    })

    await vi.waitFor(() =>
      expect(latestDiffContents[activeFile.id]?.modifiedContent).toBe('refreshed diff content')
    )
    expect(mocks.getRuntimeGitDiff).toHaveBeenCalledTimes(2)
  })
})
