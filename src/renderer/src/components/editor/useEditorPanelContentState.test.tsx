// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { GitStatusEntry } from '../../../../shared/git/status/git-status-types'
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

vi.mock('@/runtime/runtime-file-routing', () => ({
  getRuntimeFileReadScope: vi.fn(
    (
      target: { kind: 'local' } | { kind: 'environment'; environmentId: string },
      connectionId?: string
    ) => connectionId ?? (target.kind === 'environment' ? target.environmentId : null)
  )
}))
vi.mock('@/runtime/runtime-file-read-client', () => ({
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))
vi.mock('@/runtime/runtime-file-watch-client', () => ({ subscribeRuntimeFileChanges: vi.fn() }))

vi.mock('@/runtime/runtime-git-diff-client', () => ({
  getRuntimeGitBranchDiff: mocks.getRuntimeGitBranchDiff,
  getRuntimeGitCommitDiff: vi.fn(),
  getRuntimeGitDiff: mocks.getRuntimeGitDiff
}))
// The diff loader routes working diffs through Perforce or Git; these suites cover Git.
vi.mock('@/runtime/runtime-worktree-file-diff', () => ({
  getRuntimeWorktreeFileDiff: mocks.getRuntimeGitDiff
}))
vi.mock('@/runtime/runtime-git-client-context', () => ({ getRuntimeGitScope: vi.fn(() => null) }))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: mocks.getConnectionId,
  getConnectionIdForFile: mocks.getConnectionIdForFile,
  isWorktreeConnectionResolved: mocks.isWorktreeConnectionResolved
}))

vi.mock('@/lib/worktree-host-connection-phase', () => import('./local-host-test-fixture'))

vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: vi.fn(() => null)
}))

// Fixture owners: `repo-runtime::` workspaces live on runtime-1, everything else here is local.
vi.mock('@/lib/file-owner-runtime-target', () => {
  const ownerTarget = (_s: unknown, worktreeId?: string, owner?: string | null) => {
    const id = owner === undefined && worktreeId?.startsWith('repo-runtime::') ? 'runtime-1' : owner
    return id ? { kind: 'environment', environmentId: id } : { kind: 'local' }
  }
  return {
    getRuntimeTargetForFileOwner: ownerTarget,
    requireRuntimeTargetForFileOwner: ownerTarget
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (select: (state: ReturnType<typeof mocks.getState>) => unknown) => select(mocks.getState()),
    { getState: mocks.getState }
  )
}))

import { useEditorPanelContentState } from './useEditorPanelContentState'
import { createTestStore } from '@/store/slices/store-test-helpers'

import { ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT } from './autosave/editor-autosave'
import { registerEditorPanelHostContentRecoveryTests } from './editor-panel-host-content-recovery.spec'

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
}

// Why: opening any liveTail tab arms useLocalLogTail's change subscription.
const onLocalLogTailChanged = vi.fn(() => () => {})
const fsApi = { onLocalLogTailChanged }
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
    gitStatusEntries: activeFile ? gitStatusByWorktree[activeFile.worktreeId] : undefined,
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
      ...createTestStore().getState(),
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

  registerEditorPanelHostContentRecoveryTests(
    mocks,
    () => latestFileContents,
    async (file) => {
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      await act(async () => root?.render(<HookProbe activeFile={file} openFiles={[file]} />))
    }
  )

  it('ignores an older file read that resolves after a newer forced read', async () => {
    const activeFile = createOpenFile()
    const staleRead = createDeferred<FileContent>()
    const freshRead = createDeferred<FileContent>()
    mocks.readRuntimeFileContent
      .mockReturnValueOnce(staleRead.promise)
      .mockReturnValueOnce(freshRead.promise)

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })
    await vi.waitFor(() => expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(1))

    dispatchExternalFileChange(activeFile, '/repo')
    await vi.waitFor(() => expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(2))

    await act(async () => {
      freshRead.resolve({ content: 'fresh content', isBinary: false })
      await freshRead.promise
    })
    await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.content).toBe('fresh content'))

    await act(async () => {
      staleRead.resolve({ content: 'stale content', isBinary: false })
      await staleRead.promise
    })
    expect(latestFileContents[activeFile.id]?.content).toBe('fresh content')
  })

  it('keeps non-tab conflict-review file generations until the load resolves', async () => {
    const activeFile = createOpenFile({
      id: 'wt-1::conflict-review',
      filePath: '/repo',
      relativePath: 'Conflict Review',
      language: 'plaintext',
      mode: 'conflict-review',
      conflictReview: {
        source: 'live-summary',
        snapshotTimestamp: 123,
        entries: [{ path: 'src/conflict.ts', conflictKind: 'both_modified' }]
      }
    })
    const conflictRead = createDeferred<FileContent>()
    mocks.readRuntimeFileContent.mockReturnValueOnce(conflictRead.promise)

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <HookProbe
          activeFile={activeFile}
          openFiles={[activeFile]}
          gitStatusByWorktree={{
            'wt-1': [
              {
                path: 'src/conflict.ts',
                status: 'modified',
                area: 'unstaged',
                conflictStatus: 'unresolved',
                conflictKind: 'both_modified'
              }
            ]
          }}
        />
      )
    })
    await vi.waitFor(() => expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(1))

    await act(async () => {
      conflictRead.resolve({
        content: '<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> branch',
        isBinary: false
      })
      await conflictRead.promise
    })

    expect(latestFileContents['/repo/src/conflict.ts']?.content).toContain('incoming')
  })

  it('ignores an older file read after closing and reopening the same tab id', async () => {
    const activeFile = createOpenFile()
    const staleRead = createDeferred<FileContent>()
    const freshRead = createDeferred<FileContent>()
    mocks.readRuntimeFileContent
      .mockReturnValueOnce(staleRead.promise)
      .mockReturnValueOnce(freshRead.promise)

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })
    await vi.waitFor(() => expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(1))

    await act(async () => {
      root?.render(<HookProbe activeFile={null} openFiles={[]} />)
    })
    expect(latestFileContents[activeFile.id]).toBeUndefined()

    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })
    await vi.waitFor(() => expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(2))

    await act(async () => {
      freshRead.resolve({ content: 'fresh reopen content', isBinary: false })
      await freshRead.promise
    })
    await vi.waitFor(() =>
      expect(latestFileContents[activeFile.id]?.content).toBe('fresh reopen content')
    )

    await act(async () => {
      staleRead.resolve({ content: 'stale pre-close content', isBinary: false })
      await staleRead.promise
    })
    expect(latestFileContents[activeFile.id]?.content).toBe('fresh reopen content')
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
})
