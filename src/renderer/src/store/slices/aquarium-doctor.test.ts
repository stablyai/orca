import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { DaemonInventoryScanResult } from '../../../../shared/daemon-inventory'
import type { AppState } from '../types'
import { createDaemonInventorySlice } from './daemon-inventory'
import { createAquariumDoctorSlice } from './aquarium-doctor'

// Why: the doctor action talks to the main process via the daemon-inventory
// slice (window.api.daemonInventory.scan); the slice test stubs window the
// same way daemon-inventory.test.ts does.

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

function createDoctorTestStore() {
  const store = create<AppState>()(
    (...a) =>
      ({
        ...createDaemonInventorySlice(...a),
        ...createAquariumDoctorSlice(...a)
      }) as unknown as AppState
  )
  // The doctor action reads the panel's live sources; seed the empty defaults
  // the other store slices normally provide (buildLiveAquariumEntries reads
  // these directly, so a missing field throws instead of classifying empty).
  store.setState({
    workspaceCleanupScan: { scannedAt: 0, candidates: [], errors: [] },
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: {},
    daemonInventoryScan: null,
    daemonInventoryError: null
  } as Partial<AppState>)
  return store
}

function makeLiveDaemonScan(): DaemonInventoryScanResult {
  return {
    daemons: [
      {
        id: 'daemon-v8',
        host: 'mbp-brandon',
        ownerUid: 501,
        generation: 8,
        pid: 8001,
        startedAtMs: 1_700_000_000_000,
        entryPath: '/x/entry.js',
        appVersion: '8.0.0',
        pidFile: '/x/daemon-v8.pid',
        sockFile: '/x/daemon-v8.sock',
        hasSock: true,
        hasToken: true,
        isLive: true,
        source: 'mac-prod'
      }
    ]
  }
}

describe('aquarium doctor slice', () => {
  it('starts null with no scanning flag', () => {
    const store = createDoctorTestStore()
    expect(store.getState().doctorScan).toBeNull()
    expect(store.getState().doctorScanning).toBe(false)
  })

  it('runDoctorScan refreshes the daemon family then computes a verdict', async () => {
    const store = createDoctorTestStore()
    scanMock.mockResolvedValue(makeLiveDaemonScan())

    const result = await store.getState().runDoctorScan()

    // The daemon family was refreshed through the T9 IPC first.
    expect(scanMock).toHaveBeenCalledTimes(1)
    // With only a live daemon generation, the verdict is healthy.
    expect(result.healthy).toBe(true)
    expect(result.daemons).toEqual({ total: 1, live: 1, stale: 0 })
    expect(store.getState().doctorScan).toEqual(result)
    expect(store.getState().doctorScanning).toBe(false)
  })

  it('folds a daemon refresh failure into cliErrors — a partial scan is never healthy (Offer 4)', async () => {
    const store = createDoctorTestStore()
    scanMock.mockRejectedValue(new Error('scan failed'))

    const result = await store.getState().runDoctorScan()

    expect(result.healthy).toBe(false)
    expect(result.cliErrors.daemonScan).toBe('scan failed')
    expect(store.getState().doctorScanning).toBe(false)
  })
})
