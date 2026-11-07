import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import { createTestStore } from '@/store/slices/store-test-helpers'

import type { AppState } from '@/store/types'
import { attachRestoredTabConflictScan } from './editor-restored-tab-conflict-scan'
import { getDiskBaselineSignature } from '../../../../../shared/disk-baseline-signature'
import { __clearSelfWriteRegistryForTests, recordSelfWrite } from './editor-self-write-registry'

const mocks = vi.hoisted(() => ({
  readRuntimeFileContent: vi.fn(),
  getConnectionIdForFile: vi.fn(),
  pathExists: vi.fn()
}))

vi.mock('@/runtime/files/reads/runtime-file-read-client', () => ({
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
