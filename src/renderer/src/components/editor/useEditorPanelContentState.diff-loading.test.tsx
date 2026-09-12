// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary
} from '../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import type { DiffContent, FileContent } from './editor-panel-content-types'

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
import { ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT } from './editor-autosave'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function dispatchExternalFileChange(file: OpenFile, worktreePath: string): void {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
        detail: {
          worktreeId: file.worktreeId,
          worktreePath,
          relativePath: file.relativePath
        }
      })
    )
  })
}

type ProbeProps = {
  activeFile: OpenFile | null
  openFiles: OpenFile[]
  gitStatusByWorktree?: Record<string, GitStatusEntry[]>
  gitBranchChangesByWorktree?: Record<string, GitBranchChangeEntry[]>
  gitBranchCompareSummaryByWorktree?: Record<string, GitBranchCompareSummary | null>
}

const authorizeExternalPath = vi.fn()
// Why: opening any liveTail tab arms useLocalLogTail's change subscription.
const onLocalLogTailChanged = vi.fn(() => () => {})
const fsApi = { authorizeExternalPath, onLocalLogTailChanged }
let latestFileContents: Record<string, FileContent> = {}
let latestDiffContents: Record<string, DiffContent> = {}
let latestReloadContent: (file: OpenFile) => void = () => {}
const EMPTY_GIT_STATUS_BY_WORKTREE: Record<string, GitStatusEntry[]> = {}
const EMPTY_GIT_BRANCH_CHANGES_BY_WORKTREE: Record<string, GitBranchChangeEntry[]> = {}
const EMPTY_GIT_BRANCH_COMPARE_SUMMARY_BY_WORKTREE: Record<string, GitBranchCompareSummary | null> =
  {}

function HookProbe({
  activeFile,
  openFiles,
  gitStatusByWorktree = EMPTY_GIT_STATUS_BY_WORKTREE,
  gitBranchChangesByWorktree = EMPTY_GIT_BRANCH_CHANGES_BY_WORKTREE,
  gitBranchCompareSummaryByWorktree = EMPTY_GIT_BRANCH_COMPARE_SUMMARY_BY_WORKTREE
}: ProbeProps): null {
  const state = useEditorPanelContentState({
    activeFile,
    isChangesMode: false,
    openFiles,
    gitStatusEntries: activeFile ? gitStatusByWorktree[activeFile.worktreeId] : undefined,
    gitBranchEntries: activeFile ? gitBranchChangesByWorktree[activeFile.worktreeId] : undefined,
    gitBranchCompareSummary: activeFile
      ? gitBranchCompareSummaryByWorktree[activeFile.worktreeId]
      : undefined,
    changedLineHighlightsEnabled: true,
    editorViewMode: {}
  })
  latestFileContents = state.fileContents
  latestDiffContents = state.diffContents
  latestReloadContent = state.reloadContent
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

describe('useEditorPanelContentState diff loading', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    latestFileContents = {}
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

  it('loads folder workspace branch diffs through the path-specific SSH connection', async () => {
    const activeFile = createOpenFile({
      id: 'branch-diff',
      filePath: '/home/neil/platform/api/src/file.ts',
      relativePath: 'api/src/file.ts',
      worktreeId: 'folder:folder-workspace-1',
      mode: 'diff',
      diffSource: 'branch',
      branchCompare: {
        baseRef: 'main',
        compareRef: 'feature',
        compareVersion: 'feature',
        baseOid: 'base',
        headOid: 'head',
        mergeBase: 'merge-base'
      }
    })
    mocks.getConnectionIdForFile.mockReturnValue('ssh-1')
    mocks.getRuntimeGitBranchDiff.mockResolvedValue({
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'remote branch diff',
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
      expect(latestDiffContents[activeFile.id]?.modifiedContent).toBe('remote branch diff')
    )
    expect(mocks.getConnectionIdForFile).toHaveBeenCalledWith(
      'folder:folder-workspace-1',
      '/home/neil/platform/api/src/file.ts'
    )
    expect(mocks.getRuntimeGitBranchDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'folder:folder-workspace-1',
        worktreePath: '/home/neil/platform',
        connectionId: 'ssh-1'
      }),
      expect.objectContaining({
        compare: expect.objectContaining({ headOid: 'head', mergeBase: 'merge-base' }),
        filePath: 'api/src/file.ts'
      })
    )
  })

  it('loads branch comparison diffs for normal edit tabs changed relative to base', async () => {
    const activeFile = createOpenFile({
      id: '/repo/src/file.ts',
      filePath: '/repo/src/file.ts',
      relativePath: 'src/file.ts',
      worktreeId: 'wt-1'
    })
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'new', isBinary: false })
    mocks.getRuntimeGitBranchDiff.mockResolvedValue({
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
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
          gitBranchChangesByWorktree={{
            'wt-1': [{ path: 'src/file.ts', status: 'modified' }]
          }}
          gitBranchCompareSummaryByWorktree={{
            'wt-1': {
              baseRef: 'origin/main',
              compareRef: 'feature/example',
              baseOid: 'base',
              headOid: 'head',
              mergeBase: 'merge-base',
              changedFiles: 1,
              status: 'ready'
            }
          }}
        />
      )
    })

    await vi.waitFor(() => expect(latestDiffContents[activeFile.id]?.originalContent).toBe('old'))
    expect(mocks.getRuntimeGitBranchDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      }),
      expect.objectContaining({
        compare: expect.objectContaining({
          baseOid: 'base',
          headOid: 'head',
          mergeBase: 'merge-base'
        }),
        filePath: 'src/file.ts'
      })
    )
    expect(mocks.getRuntimeGitDiff).not.toHaveBeenCalled()
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

  it('loads a diff baseline for changed edit tabs outside Changes mode', async () => {
    const activeFile = createOpenFile()
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'fresh content', isBinary: false })
    mocks.getRuntimeGitDiff.mockResolvedValue({
      kind: 'text',
      originalContent: 'old content',
      modifiedContent: 'fresh content',
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
      expect(latestDiffContents[activeFile.id]?.originalContent).toBe('old content')
    )
    expect(mocks.getRuntimeGitDiff).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        filePath: 'file.ts',
        compareAgainstHead: true,
        staged: false
      })
    )
  })

  it('does not load a diff baseline for clean edit tabs outside Changes mode', async () => {
    const activeFile = createOpenFile()
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'fresh content', isBinary: false })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })

    await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.content).toBe('fresh content'))
    expect(mocks.getRuntimeGitDiff).not.toHaveBeenCalled()
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

  it('ignores an older diff read that resolves after a newer forced diff read', async () => {
    const activeFile = createOpenFile({
      id: 'wt-1::diff::unstaged::file.ts',
      mode: 'diff',
      diffSource: 'unstaged'
    })
    const staleDiff = createDeferred<DiffContent>()
    const freshDiff = createDeferred<DiffContent>()
    mocks.getRuntimeGitDiff
      .mockReturnValueOnce(staleDiff.promise)
      .mockReturnValueOnce(freshDiff.promise)

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })
    await vi.waitFor(() => expect(mocks.getRuntimeGitDiff).toHaveBeenCalledTimes(1))

    dispatchExternalFileChange(activeFile, '/repo')
    await vi.waitFor(() => expect(mocks.getRuntimeGitDiff).toHaveBeenCalledTimes(2))

    await act(async () => {
      freshDiff.resolve({
        kind: 'text',
        originalContent: 'old',
        modifiedContent: 'fresh diff content',
        originalIsBinary: false,
        modifiedIsBinary: false
      })
      await freshDiff.promise
    })
    await vi.waitFor(() =>
      expect(latestDiffContents[activeFile.id]?.modifiedContent).toBe('fresh diff content')
    )

    await act(async () => {
      staleDiff.resolve({
        kind: 'text',
        originalContent: 'old',
        modifiedContent: 'stale diff content',
        originalIsBinary: false,
        modifiedIsBinary: false
      })
      await staleDiff.promise
    })
    expect(latestDiffContents[activeFile.id]?.modifiedContent).toBe('fresh diff content')
  })

  it('routes reloadContent for a diff tab to a forced diff refetch, not a file read', async () => {
    // Why: the changed-on-disk banner's "Reload from Disk" on an unstaged
    // diff tab must refetch the diff body — routing it to the file store
    // would leave the visible diff stale (and vice versa for edit tabs).
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
        modifiedContent: 'reloaded diff content',
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
      latestReloadContent(activeFile)
    })

    await vi.waitFor(() =>
      expect(latestDiffContents[activeFile.id]?.modifiedContent).toBe('reloaded diff content')
    )
    expect(mocks.getRuntimeGitDiff).toHaveBeenCalledTimes(2)
    expect(mocks.readRuntimeFileContent).not.toHaveBeenCalled()
  })
})
