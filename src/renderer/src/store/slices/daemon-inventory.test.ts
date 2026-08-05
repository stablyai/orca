import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { DaemonInventoryScanResult } from '../../../../shared/daemon-inventory'
import type { AppState } from '../types'
import { createDaemonInventorySlice } from './daemon-inventory'

// Why: the scan action talks to the main process via window.api; the slice
// test stubs window the same way workspace-cleanup.test.ts does.

const { scanMock } = vi.hoisted(() => ({
  scanMock: vi.fn()
}))

beforeEach(() => {
  scanMock.mockReset()
  ;(globalThis as { window: unknown }).window = {
    api: {
      daemonInventory: {
        scan: scanMock
      }
    }
  }
})

function createDaemonInventoryTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        ...createDaemonInventorySlice(...a)
      }) as unknown as AppState
  )
}

function makeScanResult(): DaemonInventoryScanResult {
  return {
    daemons: [
      {
        id: 'daemon-v7',
        host: 'mbp-brandon',
        ownerUid: 501,
        generation: 7,
        pid: 7001,
        startedAtMs: 1_700_000_000_000,
        entryPath: '/x/entry.js',
        appVersion: '7.0.0',
        pidFile: '/x/daemon-v7.pid',
        sockFile: '/x/daemon-v7.sock',
        hasSock: true,
        hasToken: true,
        isLive: true,
        source: 'mac-prod'
      }
    ]
  }
}

describe('daemon inventory slice', () => {
  it('starts null with no loading/error', () => {
    const store = createDaemonInventoryTestStore()
    expect(store.getState().daemonInventoryScan).toBeNull()
    expect(store.getState().daemonInventoryLoading).toBe(false)
    expect(store.getState().daemonInventoryError).toBeNull()
  })

  it('stores the scan result on success', async () => {
    const store = createDaemonInventoryTestStore()
    const result = makeScanResult()
    scanMock.mockResolvedValue(result)

    await store.getState().scanDaemonInventory()

    expect(store.getState().daemonInventoryScan).toEqual(result)
    expect(store.getState().daemonInventoryLoading).toBe(false)
    expect(store.getState().daemonInventoryError).toBeNull()
  })

  it('records the error and rethrows on scan failure', async () => {
    const store = createDaemonInventoryTestStore()
    scanMock.mockRejectedValue(new Error('scan failed'))

    await expect(store.getState().scanDaemonInventory()).rejects.toThrow('scan failed')

    expect(store.getState().daemonInventoryScan).toBeNull()
    expect(store.getState().daemonInventoryLoading).toBe(false)
    expect(store.getState().daemonInventoryError).toBe('scan failed')
  })
})
