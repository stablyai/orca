// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
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
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
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
}

// Why: opening any liveTail tab arms useLocalLogTail's change subscription.
const onLocalLogTailChanged = vi.fn(() => () => {})
const fsApi = { onLocalLogTailChanged }
let latestFileContents: Record<string, FileContent> = {}
let latestDiffContents: Record<string, DiffContent> = {}
let latestReloadContent: (file: OpenFile, options?: { wakeWslDistro?: boolean }) => void = () => {}
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

  it('lets the active tab load and its Retry start a stopped WSL distro, but not other reloads', async () => {
    const activeFile = createOpenFile()
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'text', isBinary: false })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })
    await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.content).toBe('text'))
    expect(mocks.readRuntimeFileContent).toHaveBeenLastCalledWith(
      expect.objectContaining({ wakeWslDistro: true })
    )

    await act(async () => latestReloadContent(activeFile))
    expect(mocks.readRuntimeFileContent).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ wakeWslDistro: true })
    )
    await act(async () => latestReloadContent(activeFile, { wakeWslDistro: true }))
    expect(mocks.readRuntimeFileContent).toHaveBeenLastCalledWith(
      expect.objectContaining({ wakeWslDistro: true })
    )
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

  it('loads an external SSH-host image when the tab is pinned to that target', async () => {
    const activeFile = createOpenFile({
      id: '/tmp/ssh-preview.png',
      filePath: '/tmp/ssh-preview.png',
      relativePath: '/tmp/ssh-preview.png',
      worktreeId: 'repo-ssh::/home/user/project',
      externalSshTargetId: 'ssh-1'
    } as never)
    mocks.getConnectionIdForFile.mockReturnValue('ssh-1')
    mocks.readRuntimeFileContent.mockResolvedValue({
      content: 'base64-image',
      isBinary: true,
      isImage: true,
      mimeType: 'image/png'
    })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })

    await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.isImage).toBe(true))
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/ssh-preview.png',
        relativePath: '/tmp/ssh-preview.png',
        worktreeId: 'repo-ssh::/home/user/project',
        connectionId: 'ssh-1',
        expectedExternalSshTargetId: 'ssh-1'
      })
    )
  })

  it('loads an unstamped external SSH-host tab through the resolved connection', async () => {
    const activeFile = createOpenFile({
      id: '/work/reports/audit.md',
      filePath: '/work/reports/audit.md',
      relativePath: '/work/reports/audit.md',
      worktreeId: 'repo-ssh::/work/demo-project'
    })
    mocks.getConnectionIdForFile.mockReturnValue('ssh-1')
    mocks.readRuntimeFileContent.mockResolvedValue({ content: '# remote', isBinary: false })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })

    await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.content).toBe('# remote'))
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/work/reports/audit.md',
        connectionId: 'ssh-1',
        expectedExternalSshTargetId: undefined
      })
    )
  })

  it('keeps a client-local live-tail log tab on the client inside an SSH workspace', async () => {
    const logPath = '/Users/me/.codex/sessions/session.jsonl'
    const worktreeId = 'repo-ssh::/work/demo-project'
    const externalTab = { id: logPath, filePath: logPath, relativePath: logPath, worktreeId }
    const activeFile = createOpenFile({ ...externalTab, readOnly: true, liveTail: true })
    mocks.getConnectionIdForFile.mockReturnValue('ssh-1')
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'log line', isBinary: false })

    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)

    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })

    await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.content).toBe('log line'))
    // AI Vault logs are client-local user-named paths and must not inherit workspace SSH ownership.
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: undefined,
        includeLocalLogMetadata: true,
        access: { kind: 'user-file' }
      })
    )
  })

  it('rejects an external SSH-host tab after its target owner changes', async () => {
    const activeFile = createOpenFile({
      id: '/tmp/ssh-preview.png',
      filePath: '/tmp/ssh-preview.png',
      relativePath: '/tmp/ssh-preview.png',
      worktreeId: 'repo-ssh::/home/user/project',
      externalSshTargetId: 'ssh-original'
    } as never)
    mocks.getConnectionIdForFile.mockReturnValue('ssh-replacement')
    mocks.readRuntimeFileContent.mockRejectedValue(
      new Error('External SSH files are not available after the workspace host changes.')
    )

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })

    await vi.waitFor(() =>
      expect(latestFileContents[activeFile.id]?.loadError).toBe(
        'External SSH files are not available after the workspace host changes.'
      )
    )
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'ssh-replacement',
        expectedExternalSshTargetId: 'ssh-original'
      })
    )
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
      }),
      // Showing the tab is a user act; the client drops the hint for an SSH connection.
      { wakeWslDistro: true }
    )
  })

  it('does not read locally while a remote host worktree owner is still hydrating (#6648)', async () => {
    const activeFile = createOpenFile({
      filePath: '/home/user/project/src/index.ts',
      relativePath: 'src/index.ts',
      worktreeId: 'repo-ssh::/home/user/project'
    })
    // Owner unknown (SSH repo not hydrated): connection unresolved + not ready.
    mocks.getConnectionIdForFile.mockReturnValue(undefined)
    mocks.isWorktreeConnectionResolved.mockReturnValue(false)

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })

    // Unresolved ownership must remain retryable without attempting a client-local read of the remote path.
    await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.loadError).toBeTruthy())
    expect(latestFileContents[activeFile.id]?.loadError).not.toMatch(/access denied/i)
    expect(mocks.readRuntimeFileContent).not.toHaveBeenCalled()

    // Hydrate ownership without bumping reload nonce so automatic retry alone must recover the read.
    mocks.isWorktreeConnectionResolved.mockReturnValue(true)
    mocks.getConnectionIdForFile.mockReturnValue('ssh-target-1')
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'remote', isBinary: false })

    await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.content).toBe('remote'), {
      timeout: 3000
    })
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/home/user/project/src/index.ts',
        worktreeId: 'repo-ssh::/home/user/project',
        connectionId: 'ssh-target-1'
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

  it('starts a fresh file read for a forced reload instead of reusing the in-flight read', async () => {
    // Mount starts lazy and forced reads in one effect flush; forcing must supersede the in-flight entry.
    const activeFile = createOpenFile({ fileContentReloadNonce: 1 })
    const firstRead = createDeferred<FileContent>()
    const secondRead = createDeferred<FileContent>()
    mocks.readRuntimeFileContent
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise)

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })

    await vi.waitFor(() => expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(2))

    await act(async () => {
      secondRead.resolve({ content: 'fresh content', isBinary: false })
      await secondRead.promise
    })
    await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.content).toBe('fresh content'))
  })

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

  it('routes reloadContent for a diff tab to a forced diff refetch, not a file read', async () => {
    // Banner reload must update the visible diff body rather than only the plain-file cache.
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

  it('routes reloadContent for an edit tab to a forced file read, not a diff refetch', async () => {
    const activeFile = createOpenFile()
    mocks.readRuntimeFileContent
      .mockResolvedValueOnce({ content: 'old content', isBinary: false })
      .mockResolvedValueOnce({ content: 'reloaded content', isBinary: false })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })
    await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.content).toBe('old content'))

    await act(async () => {
      latestReloadContent(activeFile)
    })

    await vi.waitFor(() =>
      expect(latestFileContents[activeFile.id]?.content).toBe('reloaded content')
    )
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(2)
    expect(mocks.getRuntimeGitDiff).not.toHaveBeenCalled()
  })

  it('stamps the disk baseline when a clean tab load resolves', async () => {
    const activeFile = createOpenFile()
    const setLastKnownDiskSignature = vi.fn()
    mocks.getState.mockReturnValue({
      ...createTestStore().getState(),
      settings: null,
      openFiles: [activeFile],
      setLastKnownDiskSignature
    })
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'disk content', isBinary: false })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })

    await vi.waitFor(() =>
      expect(setLastKnownDiskSignature).toHaveBeenCalledWith(
        activeFile.id,
        getDiskBaselineSignature('disk content')
      )
    )
  })

  it('keeps a dirty tab baseline untouched by content loads', async () => {
    // Dirty drafts retain their original disk baseline so content loading cannot hide external conflicts.
    const activeFile = createOpenFile({ isDirty: true })
    const setLastKnownDiskSignature = vi.fn()
    mocks.getState.mockReturnValue({
      ...createTestStore().getState(),
      settings: null,
      openFiles: [activeFile],
      setLastKnownDiskSignature
    })
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'disk content', isBinary: false })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<HookProbe activeFile={activeFile} openFiles={[activeFile]} />)
    })

    await vi.waitFor(() => expect(latestFileContents[activeFile.id]?.content).toBe('disk content'))
    expect(setLastKnownDiskSignature).not.toHaveBeenCalled()
  })
})
