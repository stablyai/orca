import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { createEditorSlice } from '@/store/slices/editor'
import type { AppState } from '@/store'
import { attachRestoredTabConflictScan } from './editor-restored-tab-conflict-scan'
import { getDiskBaselineSignature } from './diff-content-signature'

const mocks = vi.hoisted(() => ({
  readRuntimeFileContent: vi.fn(),
  getConnectionIdForFile: vi.fn(),
  pathExists: vi.fn()
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: () => null
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))

function createEditorStore(): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    settings: {},
    ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
  })) as unknown as StoreApi<AppState>
}

function openRestoredDirtyTab(
  store: StoreApi<AppState>,
  filePath: string,
  baselineContent: string
): void {
  store.getState().openFile({
    filePath,
    relativePath: filePath.slice(1),
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit'
  })
  store.getState().setEditorDraft(filePath, 'restored draft')
  store.getState().markFileDirty(filePath, true)
  store.getState().setLastKnownDiskSignature(filePath, getDiskBaselineSignature(baselineContent))
  // Why: hydration flags restored dirty tabs for verification; tests mimic it.
  store.setState({
    openFiles: store
      .getState()
      .openFiles.map((f) =>
        f.id === filePath ? { ...f, pendingDiskBaselineVerification: true } : f
      )
  } as never)
}

describe('attachRestoredTabConflictScan', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.readRuntimeFileContent.mockReset()
    mocks.getConnectionIdForFile.mockReset()
    mocks.getConnectionIdForFile.mockReturnValue(undefined)
    mocks.pathExists.mockReset()
    mocks.pathExists.mockResolvedValue(true)
    vi.stubGlobal('window', { api: { fs: { pathExists: mocks.pathExists } } })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('marks a restored dirty tab whose file changed while the app was closed', async () => {
    mocks.readRuntimeFileContent.mockResolvedValue({
      content: 'agent rewrote this offline',
      isBinary: false
    })
    const store = createEditorStore()
    openRestoredDirtyTab(store, '/repo/file.ts', 'original baseline')

    const detach = attachRestoredTabConflictScan(store)
    try {
      await vi.advanceTimersByTimeAsync(10)
      expect(store.getState().openFiles[0]?.externalMutation).toBe('changed')
    } finally {
      detach()
    }
  })

  it('leaves a restored dirty tab unmarked when disk still matches its baseline', async () => {
    mocks.readRuntimeFileContent.mockResolvedValue({
      content: 'original baseline',
      isBinary: false
    })
    const store = createEditorStore()
    openRestoredDirtyTab(store, '/repo/file.ts', 'original baseline')

    const detach = attachRestoredTabConflictScan(store)
    try {
      await vi.advanceTimersByTimeAsync(10)
      expect(store.getState().openFiles[0]?.externalMutation).toBeUndefined()
      expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(1)
    } finally {
      detach()
    }
  })

  it('does not read files for clean tabs or tabs without a baseline', async () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/clean.ts',
      relativePath: 'clean.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().openFile({
      filePath: '/repo/dirty-no-baseline.ts',
      relativePath: 'dirty-no-baseline.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setEditorDraft('/repo/dirty-no-baseline.ts', 'draft')
    store.getState().markFileDirty('/repo/dirty-no-baseline.ts', true)

    const detach = attachRestoredTabConflictScan(store)
    try {
      await vi.advanceTimersByTimeAsync(10)
      expect(mocks.readRuntimeFileContent).not.toHaveBeenCalled()
    } finally {
      detach()
    }
  })

  it('retries a failed read and marks once the file becomes readable', async () => {
    // Why: SSH/runtime connections come up after launch; the first reads fail.
    mocks.readRuntimeFileContent
      .mockRejectedValueOnce(new Error('connection not ready'))
      .mockResolvedValue({ content: 'agent rewrote this offline', isBinary: false })
    const store = createEditorStore()
    openRestoredDirtyTab(store, '/repo/file.ts', 'original baseline')

    const detach = attachRestoredTabConflictScan(store)
    try {
      await vi.advanceTimersByTimeAsync(10)
      expect(store.getState().openFiles[0]?.externalMutation).toBeUndefined()
      await vi.advanceTimersByTimeAsync(2_100)
      expect(store.getState().openFiles[0]?.externalMutation).toBe('changed')
    } finally {
      detach()
    }
  })

  it('clears the pending-verification flag on both verification outcomes', async () => {
    mocks.readRuntimeFileContent.mockResolvedValue({
      content: 'original baseline',
      isBinary: false
    })
    const store = createEditorStore()
    openRestoredDirtyTab(store, '/repo/match.ts', 'original baseline')

    const detach = attachRestoredTabConflictScan(store)
    try {
      await vi.advanceTimersByTimeAsync(10)
      // Why: the flag suspends autosave — leaving it set after a clean
      // verification would strand the tab's autosave forever.
      expect(store.getState().openFiles[0]?.pendingDiskBaselineVerification).toBeUndefined()

      mocks.readRuntimeFileContent.mockResolvedValue({
        content: 'agent rewrote this offline',
        isBinary: false
      })
      openRestoredDirtyTab(store, '/repo/mismatch.ts', 'original baseline')
      await vi.advanceTimersByTimeAsync(10)
      const mismatchTab = store.getState().openFiles.find((f) => f.id === '/repo/mismatch.ts')
      expect(mismatchTab?.externalMutation).toBe('changed')
      expect(mismatchTab?.pendingDiskBaselineVerification).toBeUndefined()
    } finally {
      detach()
    }
  })

  it('does not re-verify live dirty tabs that were never flagged at hydration', async () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/live.ts',
      relativePath: 'live.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setEditorDraft('/repo/live.ts', 'live edits')
    store.getState().markFileDirty('/repo/live.ts', true)
    store.getState().setLastKnownDiskSignature('/repo/live.ts', getDiskBaselineSignature('base'))

    const detach = attachRestoredTabConflictScan(store)
    try {
      await vi.advanceTimersByTimeAsync(10)
      // Why: in-session drift is the live watcher's job; re-reading here would
      // turn the scan into a poller and skew the 'restore' telemetry origin.
      expect(mocks.readRuntimeFileContent).not.toHaveBeenCalled()
    } finally {
      detach()
    }
  })

  it('resolves verification with a deleted mark when the file is definitively gone', async () => {
    // Why: a file deleted while the app was closed can never verify — without
    // a terminal state the retry loop keeps the tab's autosave silently
    // suspended for the whole session.
    mocks.readRuntimeFileContent.mockRejectedValue(new Error('ENOENT'))
    mocks.pathExists.mockResolvedValue(false)
    const store = createEditorStore()
    openRestoredDirtyTab(store, '/repo/deleted.ts', 'original baseline')

    const detach = attachRestoredTabConflictScan(store)
    try {
      await vi.advanceTimersByTimeAsync(10)
      const tab = store.getState().openFiles[0]
      expect(tab?.pendingDiskBaselineVerification).toBeUndefined()
      expect(tab?.externalMutation).toBe('deleted')
      // Why: the verification is resolved — no further retries may fire.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(1)
    } finally {
      detach()
    }
  })

  it('keeps retrying with the suspension intact when the existence probe fails', async () => {
    // Why: a transport that is down cannot disprove existence — lifting the
    // suspension unverified would reopen the clobber window the moment the
    // transport recovers.
    mocks.readRuntimeFileContent.mockRejectedValue(new Error('connection not ready'))
    mocks.pathExists.mockRejectedValue(new Error('connection not ready'))
    const store = createEditorStore()
    openRestoredDirtyTab(store, '/repo/unreachable.ts', 'original baseline')

    const detach = attachRestoredTabConflictScan(store)
    try {
      await vi.advanceTimersByTimeAsync(10)
      await vi.advanceTimersByTimeAsync(2_100)
      const tab = store.getState().openFiles[0]
      expect(tab?.pendingDiskBaselineVerification).toBe(true)
      expect(tab?.externalMutation).toBeUndefined()
      expect(mocks.readRuntimeFileContent.mock.calls.length).toBeGreaterThan(1)
    } finally {
      detach()
    }
  })

  it('does not mark a tab that was saved while the read was in flight', async () => {
    let resolveRead: (value: { content: string; isBinary: boolean }) => void = () => {}
    mocks.readRuntimeFileContent.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve
      })
    )
    const store = createEditorStore()
    openRestoredDirtyTab(store, '/repo/file.ts', 'original baseline')

    const detach = attachRestoredTabConflictScan(store)
    try {
      store.getState().markFileDirty('/repo/file.ts', false)
      resolveRead({ content: 'agent rewrote this offline', isBinary: false })
      await vi.advanceTimersByTimeAsync(10)
      expect(store.getState().openFiles[0]?.externalMutation).toBeUndefined()
    } finally {
      detach()
    }
  })
})
