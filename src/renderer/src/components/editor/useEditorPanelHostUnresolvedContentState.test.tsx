// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  readRuntimeFileContent: vi.fn()
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  getRuntimeFileReadScope: vi.fn(
    (settings: { activeRuntimeEnvironmentId?: string | null } | null | undefined) =>
      settings?.activeRuntimeEnvironmentId ?? null
  ),
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

vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: vi.fn(() => null)
}))

vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))

import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import {
  WORKTREE_HOST_UNRESOLVED_CODE,
  WORKTREE_HOST_UNRESOLVED_ERROR
} from './editor-panel-content-types'
import { useEditorPanelContentState } from './useEditorPanelContentState'
import { FILE_LOAD_RETRY_DELAYS_MS } from './useEditorPanelFileLoadRetry'

let latestFileContents: Record<string, FileContent> = {}

const EMPTY_EDITOR_VIEW_MODE = {}
const HOST_READ_LATENCY_MS = 1

// Why: openFiles/editorViewMode must be referentially stable across renders — the prune
// effect keys on them, and a fresh array per render would loop it.
function Probe({ activeFile, openFiles }: { activeFile: OpenFile; openFiles: OpenFile[] }): null {
  const state = useEditorPanelContentState({
    activeFile,
    isChangesMode: false,
    openFiles,
    gitStatusEntries: undefined,
    editorViewMode: EMPTY_EDITOR_VIEW_MODE
  })
  latestFileContents = state.fileContents
  return null
}

// A host-mirrored markdown tab in a runtime-owned worktree, with unsaved edits.
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
      fs: { authorizeExternalPath: vi.fn(), onLocalLogTailChanged: vi.fn(() => () => {}) }
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

  it('keeps a dirty mirrored tab open when the host keeps answering selector_not_found', async () => {
    // Why: selector_not_found is the host's "could not resolve right now", not proof the
    // workspace is gone. The only safe outcome is a bounded retry that ends in a truthful
    // terminal message with the tab and its draft untouched — never a close.
    const activeFile = makeDirtyMirroredFile()
    const openFiles = [activeFile]
    const closeFile = vi.fn()
    const editorDrafts = { [activeFile.id]: '# unsaved edits' }
    mocks.getState.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      openFiles,
      editorDrafts,
      closeFile,
      setLastKnownDiskSignature: vi.fn()
    })
    // Why the latency: a real host read rejects after I/O, in a later task than the retry
    // that issued it. An immediate rejection would batch with the retry's own state
    // update into one render and the effect would never re-arm — a test artifact.
    // The documented host shape: machine code on `.code`, prose on `.message`
    // (runtime-rpc-result.test.ts). Matching the message text alone would miss it.
    const hostError = new RuntimeRpcCallError({
      id: 'rpc-1',
      ok: false,
      error: { code: 'selector_not_found', message: 'Selector not found' }
    })
    mocks.readRuntimeFileContent.mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(hostError), HOST_READ_LATENCY_MS)
        })
    )

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<Probe activeFile={activeFile} openFiles={openFiles} />)
    })
    await advanceTimers(HOST_READ_LATENCY_MS)
    expect(latestFileContents[activeFile.id]?.loadError).toBe('Selector not found')
    expect(latestFileContents[activeFile.id]?.loadErrorCode).toBe('selector_not_found')

    // Exhaust the bounded backoff; every retry gets the same answer.
    for (const delayMs of FILE_LOAD_RETRY_DELAYS_MS) {
      await advanceTimers(delayMs)
      await advanceTimers(HOST_READ_LATENCY_MS)
    }
    // The budget is spent; the tab and its draft must still be there.
    expect(closeFile).not.toHaveBeenCalled()
    expect(editorDrafts[activeFile.id]).toBe('# unsaved edits')
    const expectedReads = 1 + FILE_LOAD_RETRY_DELAYS_MS.length
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(expectedReads)
    expect(latestFileContents[activeFile.id]?.loadError).toBe(WORKTREE_HOST_UNRESOLVED_ERROR)
    expect(latestFileContents[activeFile.id]?.loadErrorCode).toBe(WORKTREE_HOST_UNRESOLVED_CODE)

    // Terminal: no more reads, still no eviction.
    await advanceTimers(60_000)
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(expectedReads)
    expect(closeFile).not.toHaveBeenCalled()
  })
})
