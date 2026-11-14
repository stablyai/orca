// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { FileContent } from './editor-panel-content-types'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  readRuntimeFileContent: vi.fn()
}))

vi.mock('@/runtime/files/runtime-file-routing', () => ({
  getRuntimeFileReadScope: vi.fn(
    (settings: { activeRuntimeEnvironmentId?: string | null } | null | undefined) =>
      settings?.activeRuntimeEnvironmentId ?? null
  )
}))
vi.mock('@/runtime/files/reads/runtime-file-read-client', () => ({
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))
vi.mock('@/runtime/files/watching/runtime-file-watch-client', () => ({
  subscribeRuntimeFileChanges: vi.fn()
}))

vi.mock('@/runtime/source-control/git/runtime-git-diff-client', () => ({
  getRuntimeGitBranchDiff: vi.fn(),
  getRuntimeGitCommitDiff: vi.fn(),
  getRuntimeGitDiff: vi.fn()
}))
vi.mock('@/runtime/source-control/git/runtime-git-client-context', () => ({
  getRuntimeGitScope: vi.fn(() => null)
}))

vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionId: vi.fn(),
  getConnectionIdForFile: vi.fn(),
  isWorktreeConnectionResolved: vi.fn(() => true)
}))

vi.mock(
  '@/lib/workspace/ownership/worktree-host-connection-phase',
  () => import('../file-ownership/local-host-test-fixture')
)

vi.mock('@/lib/files/access/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: vi.fn(() => null)
}))

vi.mock('@/store/index', () => ({
  useAppStore: Object.assign(
    (select: (state: ReturnType<typeof mocks.getState>) => unknown) => select(mocks.getState()),
    { getState: mocks.getState }
  )
}))

import { useEditorPanelContentState } from './useEditorPanelContentState'

let latestFileContents: Record<string, FileContent> = {}
let latestReload: ReturnType<typeof useEditorPanelContentState>['reloadContent'] = () => {}

const EMPTY_EDITOR_VIEW_MODE = {}
const HOST_READ_LATENCY_MS = 1

// Keep fixture arrays stable because pruning keys on their identity and would otherwise loop.
function Probe({ activeFile, openFiles }: { activeFile: OpenFile; openFiles: OpenFile[] }): null {
  const state = useEditorPanelContentState({
    activeFile,
    isChangesMode: false,
    openFiles,
    gitStatusEntries: undefined,
    editorViewMode: EMPTY_EDITOR_VIEW_MODE
  })
  latestFileContents = state.fileContents
  latestReload = state.reloadContent
  return null
}

function makeDirtyMirroredFile(): OpenFile {
  return {
    id: 'mirror-1',
    filePath: '/home/user/project/NOTES.md',
    relativePath: 'NOTES.md',
    worktreeId: 'project::/home/user/project',
    language: 'markdown',
    isDirty: true,
    mode: 'markdown-preview',
    mirroredFromRuntimeSession: true,
    runtimeEnvironmentId: 'env-1'
  }
}

async function advanceTimers(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('useEditorPanelContentState — host cannot resolve a mirrored file (#21041)', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    latestFileContents = {}
    // Why: opening any tab arms useLocalLogTail's change subscription on window.api.
    vi.stubGlobal('api', {
      fs: { onLocalLogTailChanged: vi.fn(() => () => {}) }
    })
    mocks.readRuntimeFileContent.mockReset()
    mocks.getState.mockReset()
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    container = null
    root = null
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('preserves loaded content and recovers a failed load after Start', async () => {
    const activeFile = { ...makeDirtyMirroredFile(), isDirty: false }
    const openFiles = [activeFile]
    const store = createTestStore()
    store.setState({
      openFiles,
      worktreesByRepo: {
        project: [
          makeWorktree({
            id: activeFile.worktreeId,
            repoId: 'project',
            path: '/home/user/project',
            hostId: 'runtime:env-1'
          })
        ]
      },
      setLastKnownDiskSignature: vi.fn()
    })
    mocks.getState.mockImplementation(store.getState)
    mocks.readRuntimeFileContent.mockResolvedValue({ content: '# notes', isBinary: false })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<Probe activeFile={activeFile} openFiles={openFiles} />)
    })
    await advanceTimers(HOST_READ_LATENCY_MS)
    expect(latestFileContents[activeFile.id]?.content).toBe('# notes')

    await act(async () => latestReload(activeFile, { onlyIfFailed: true }))
    await advanceTimers(HOST_READ_LATENCY_MS)
    expect(latestFileContents[activeFile.id]?.content).toBe('# notes')

    // A non-retryable failure keeps the editor's own retry out of the count.
    mocks.readRuntimeFileContent.mockRejectedValueOnce(new Error('ENOENT: no such file'))
    await act(async () => latestReload(activeFile))
    await advanceTimers(HOST_READ_LATENCY_MS)
    expect(latestFileContents[activeFile.id]?.loadError).toContain('ENOENT')

    await act(async () => latestReload(activeFile, { onlyIfFailed: true }))
    await advanceTimers(HOST_READ_LATENCY_MS)
    expect(latestFileContents[activeFile.id]?.content).toBe('# notes')
  })
})
