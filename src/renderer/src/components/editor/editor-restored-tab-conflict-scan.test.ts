import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { AppState } from '@/store'
import { attachRestoredTabConflictScan } from './editor-restored-tab-conflict-scan'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { __clearSelfWriteRegistryForTests, recordSelfWrite } from './editor-self-write-registry'

const mocks = vi.hoisted(() => ({
  readRuntimeFileContent: vi.fn(),
  getConnectionIdForFile: vi.fn(),
  pathExists: vi.fn()
}))

vi.mock('@/runtime/runtime-file-read-client', () => ({
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))

function openRestoredDirtyTab(
  store: StoreApi<AppState>,
  filePath: string,
  baselineContent: string,
  owner: { relativePath: string; worktreeId: string } = {
    relativePath: filePath.slice(1),
    worktreeId: 'wt-1'
  }
): void {
  // Use owner-qualified file IDs, matching the app’s floating workspace layout.
  const fileId = store.getState().openFile({
    filePath,
    ...owner,
    language: 'typescript',
    mode: 'edit'
  })
  store.getState().setEditorDraft(fileId, 'restored draft')
  store.getState().markFileDirty(fileId, true)
  store.getState().setLastKnownDiskSignature(fileId, getDiskBaselineSignature(baselineContent))
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
    const store = createTestStore()
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
    const store = createTestStore()
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

  it('leaves a tab unmarked when disk holds its own just-written save', async () => {
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'saved earlier', isBinary: false })
    const store = createTestStore()
    openRestoredDirtyTab(store, '/repo/file.ts', 'original baseline')
    recordSelfWrite('/repo/file.ts', 'saved earlier')

    const detach = attachRestoredTabConflictScan(store)
    try {
      await vi.advanceTimersByTimeAsync(10)
      expect(store.getState().openFiles[0]?.externalMutation).toBeUndefined()
    } finally {
      detach()
      __clearSelfWriteRegistryForTests()
    }
  })

  it('does not read files for clean tabs or tabs without a baseline', async () => {
    const store = createTestStore()
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
    // SSH/runtime transports may become ready only after initial startup reads fail.
    mocks.readRuntimeFileContent
      .mockRejectedValueOnce(new Error('connection not ready'))
      .mockResolvedValue({ content: 'agent rewrote this offline', isBinary: false })
    const store = createTestStore()
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

  it('leaves a restored dirty tab unmarked when disk already holds its draft', async () => {
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'restored draft', isBinary: false })
    const store = createTestStore()
    openRestoredDirtyTab(store, '/repo/file.ts', 'original baseline')

    const detach = attachRestoredTabConflictScan(store)
    try {
      await vi.advanceTimersByTimeAsync(10)
      expect(store.getState().openFiles[0]?.externalMutation).toBeUndefined()
    } finally {
      detach()
    }
  })

  it('does not verify a tab dirtied after the scan attached', async () => {
    const store = createTestStore()
    const detach = attachRestoredTabConflictScan(store)
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

    try {
      await vi.advanceTimersByTimeAsync(10)
      // Leave in-session drift to live watchers; polling here would misattribute later conflicts to restoration.
      expect(mocks.readRuntimeFileContent).not.toHaveBeenCalled()
    } finally {
      detach()
    }
  })

  it('resolves verification with a deleted mark when the file is definitively gone', async () => {
    mocks.readRuntimeFileContent.mockRejectedValue(new Error('ENOENT'))
    mocks.pathExists.mockResolvedValue(false)
    const store = createTestStore()
    openRestoredDirtyTab(store, '/repo/deleted.ts', 'original baseline')

    const detach = attachRestoredTabConflictScan(store)
    try {
      await vi.advanceTimersByTimeAsync(10)
      const tab = store.getState().openFiles[0]
      expect(tab?.externalMutation).toBe('deleted')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(1)
    } finally {
      detach()
    }
  })

  it('keeps retrying when the existence probe fails', async () => {
    // Why: a transport that is down cannot disprove existence.
    mocks.readRuntimeFileContent.mockRejectedValue(new Error('connection not ready'))
    mocks.pathExists.mockRejectedValue(new Error('connection not ready'))
    const store = createTestStore()
    openRestoredDirtyTab(store, '/repo/unreachable.ts', 'original baseline')

    const detach = attachRestoredTabConflictScan(store)
    try {
      await vi.advanceTimersByTimeAsync(10)
      await vi.advanceTimersByTimeAsync(2_100)
      const tab = store.getState().openFiles[0]
      expect(tab?.externalMutation).toBeUndefined()
      expect(mocks.readRuntimeFileContent.mock.calls.length).toBeGreaterThan(1)
    } finally {
      detach()
    }
  })

  it('verifies a restored dirty floating-workspace tab as the file the user named', async () => {
    mocks.readRuntimeFileContent.mockRejectedValueOnce(new Error('ENOENT'))
    mocks.readRuntimeFileContent.mockResolvedValue({
      content: 'original baseline',
      isBinary: false
    })
    mocks.pathExists.mockResolvedValue(true)
    mocks.getConnectionIdForFile.mockReturnValue(null)
    const store = createTestStore()
    openRestoredDirtyTab(store, '/Users/me/notes.txt', 'original baseline', {
      relativePath: 'notes.txt',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })

    const detach = attachRestoredTabConflictScan(store)
    try {
      await vi.advanceTimersByTimeAsync(10)
      expect(mocks.pathExists).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: '/Users/me/notes.txt', access: { kind: 'user-file' } })
      )
      await vi.advanceTimersByTimeAsync(2_100)
      expect(mocks.readRuntimeFileContent).toHaveBeenLastCalledWith(
        expect.objectContaining({ filePath: '/Users/me/notes.txt', access: { kind: 'user-file' } })
      )
    } finally {
      detach()
    }
  })

  it('verifies a restored dirty project tab inside its root', async () => {
    mocks.readRuntimeFileContent.mockResolvedValue({
      content: 'original baseline',
      isBinary: false
    })
    mocks.getConnectionIdForFile.mockReturnValue(null)
    const store = createTestStore()
    openRestoredDirtyTab(store, '/repo/file.ts', 'original baseline')

    const detach = attachRestoredTabConflictScan(store)
    try {
      await vi.advanceTimersByTimeAsync(10)
      expect(mocks.readRuntimeFileContent).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: '/repo/file.ts', access: undefined })
      )
    } finally {
      detach()
    }
  })

  it('does not verify an external SSH file through a replacement target', async () => {
    const store = createTestStore()
    openRestoredDirtyTab(store, '/tmp/external.ts', 'original baseline')
    store.setState({
      openFiles: store
        .getState()
        .openFiles.map((file) => ({ ...file, externalSshTargetId: 'ssh-original' }))
    } as never)
    mocks.getConnectionIdForFile.mockReturnValue('ssh-replacement')

    const detach = attachRestoredTabConflictScan(store)
    try {
      await vi.advanceTimersByTimeAsync(10)
      expect(mocks.readRuntimeFileContent).not.toHaveBeenCalled()
      expect(mocks.pathExists).not.toHaveBeenCalled()
    } finally {
      detach()
    }
  })

  it('caps concurrent verification reads and drains the queue without dropping tabs', async () => {
    // Limit restored-tab reads so remote RPCs cannot overwhelm connection recovery; queued tabs must all complete.
    const pendingReads: ((value: { content: string; isBinary: boolean }) => void)[] = []
    mocks.readRuntimeFileContent.mockImplementation(
      () =>
        new Promise<{ content: string; isBinary: boolean }>((resolve) => {
          pendingReads.push(resolve)
        })
    )
    const store = createTestStore()
    for (let i = 0; i < 6; i++) {
      openRestoredDirtyTab(store, `/repo/file-${i}.ts`, 'original baseline')
    }

    const detach = attachRestoredTabConflictScan(store)
    try {
      expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(3)

      pendingReads.shift()!({ content: 'original baseline', isBinary: false })
      await vi.advanceTimersByTimeAsync(10)
      expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(4)

      while (pendingReads.length > 0) {
        pendingReads.shift()!({ content: 'original baseline', isBinary: false })
        await vi.advanceTimersByTimeAsync(10)
      }
      expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(6)
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
    const store = createTestStore()
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

  it('verifies a queued tab against its live baseline, not the stale queued snapshot', async () => {
    // Queued IDs can be saved or reopened before dispatch; compare current baselines rather than captured OpenFile snapshots.
    const pending: {
      filePath: string
      resolve: (value: { content: string; isBinary: boolean }) => void
    }[] = []
    mocks.readRuntimeFileContent.mockImplementation(
      ({ filePath }: { filePath: string }) =>
        new Promise<{ content: string; isBinary: boolean }>((resolve) => {
          pending.push({ filePath, resolve })
        })
    )
    const store = createTestStore()
    for (let i = 0; i < 4; i++) {
      openRestoredDirtyTab(store, `/repo/file-${i}.ts`, 'stale baseline')
    }

    const detach = attachRestoredTabConflictScan(store)
    try {
      expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(3)

      store
        .getState()
        .setLastKnownDiskSignature('/repo/file-3.ts', getDiskBaselineSignature('current disk'))

      for (const filePath of ['/repo/file-0.ts', '/repo/file-1.ts', '/repo/file-2.ts']) {
        pending
          .find((p) => p.filePath === filePath)!
          .resolve({ content: 'stale baseline', isBinary: false })
        await vi.advanceTimersByTimeAsync(10)
      }

      pending
        .find((p) => p.filePath === '/repo/file-3.ts')!
        .resolve({ content: 'current disk', isBinary: false })
      await vi.advanceTimersByTimeAsync(10)

      const tab = store.getState().openFiles.find((f) => f.id === '/repo/file-3.ts')
      expect(tab?.externalMutation).toBeUndefined()
    } finally {
      detach()
    }
  })
})
