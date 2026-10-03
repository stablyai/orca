// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import type { DiffContent } from './editor-panel-content-types'

const mocks = vi.hoisted(() => ({
  readRuntimeFileContent: vi.fn(),
  getRuntimeGitDiff: vi.fn(),
  getRuntimeGitBranchDiff: vi.fn(),
  getConnectionId: vi.fn(),
  getConnectionIdForFile: vi.fn(),
  isWorktreeConnectionResolved: vi.fn(() => true),
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
  getRuntimeGitBranchDiff: mocks.getRuntimeGitBranchDiff,
  getRuntimeGitCommitDiff: vi.fn(),
  getRuntimeGitDiff: mocks.getRuntimeGitDiff,
  getRuntimeGitScope: vi.fn(() => null)
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: mocks.getConnectionId,
  getConnectionIdForFile: mocks.getConnectionIdForFile,
  isWorktreeConnectionResolved: mocks.isWorktreeConnectionResolved
}))

vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: vi.fn(() => null)
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: mocks.getState
  }
}))

import { useEditorPanelContentState } from './useEditorPanelContentState'

type ProbeProps = {
  activeFile: OpenFile | null
  openFiles: OpenFile[]
  isChangesMode?: boolean
  gitStatusByWorktree?: Record<string, GitStatusEntry[]>
}

const authorizeExternalPath = vi.fn()
// Why: opening any liveTail tab arms useLocalLogTail's change subscription.
const onLocalLogTailChanged = vi.fn(() => () => {})
const fsApi = { authorizeExternalPath, onLocalLogTailChanged }
let latestDiffContents: Record<string, DiffContent> = {}
const EMPTY_GIT_STATUS_BY_WORKTREE: Record<string, GitStatusEntry[]> = {}

function HookProbe({
  activeFile,
  openFiles,
  isChangesMode = false,
  gitStatusByWorktree = EMPTY_GIT_STATUS_BY_WORKTREE
}: ProbeProps): null {
  const state = useEditorPanelContentState({
    activeFile,
    isChangesMode,
    openFiles,
    gitStatusEntries: activeFile ? gitStatusByWorktree[activeFile.worktreeId] : undefined,
    editorViewMode: isChangesMode && activeFile ? { [activeFile.id]: 'changes' } : {}
  })
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
    latestDiffContents = {}
    authorizeExternalPath.mockReset()
    authorizeExternalPath.mockResolvedValue(undefined)
    onLocalLogTailChanged.mockClear()
    ;(window as unknown as { api: unknown }).api = { fs: fsApi }
    mocks.readRuntimeFileContent.mockReset()
    mocks.getRuntimeGitDiff.mockReset()
    mocks.getRuntimeGitBranchDiff.mockReset()
    mocks.getConnectionId.mockReset()
    mocks.getConnectionId.mockReturnValue(undefined)
    mocks.getConnectionIdForFile.mockReset()
    mocks.getConnectionIdForFile.mockReturnValue(undefined)
    mocks.isWorktreeConnectionResolved.mockReset()
    mocks.isWorktreeConnectionResolved.mockReturnValue(true)
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

  it('uses the index for Source Control Changes and HEAD for an ordinary editable Changes tab', async () => {
    const sourceControlFile = createOpenFile({
      id: '/repo/test.md',
      filePath: '/repo/test.md',
      relativePath: 'test.md',
      language: 'markdown',
      changesAgainstIndex: true
    })
    mocks.readRuntimeFileContent.mockResolvedValue({
      content: 'staged\nunstaged\n',
      isBinary: false
    })
    mocks.getRuntimeGitDiff.mockResolvedValue({
      kind: 'text',
      originalContent: 'staged\n',
      modifiedContent: 'staged\nunstaged\n',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <HookProbe activeFile={sourceControlFile} openFiles={[sourceControlFile]} isChangesMode />
      )
    })
    await vi.waitFor(() => expect(mocks.getRuntimeGitDiff).toHaveBeenCalledTimes(1))
    expect(mocks.getRuntimeGitDiff).toHaveBeenLastCalledWith(expect.anything(), {
      filePath: 'test.md',
      staged: false,
      compareAgainstHead: false
    })
    expect(latestDiffContents[sourceControlFile.id]?.originalContent).toBe('staged\n')

    const ordinaryFile = {
      ...sourceControlFile,
      changesAgainstIndex: undefined,
      diffContentReloadNonce: 1
    }
    await act(async () => {
      root?.render(<HookProbe activeFile={ordinaryFile} openFiles={[ordinaryFile]} isChangesMode />)
    })
    await vi.waitFor(() => expect(mocks.getRuntimeGitDiff).toHaveBeenCalledTimes(2))
    expect(mocks.getRuntimeGitDiff).toHaveBeenLastCalledWith(expect.anything(), {
      filePath: 'test.md',
      staged: false,
      compareAgainstHead: true
    })
  })
})
