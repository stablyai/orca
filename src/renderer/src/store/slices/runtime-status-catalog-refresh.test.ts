import { describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { createRuntimeStatusHydration } from './runtime-status-hydration'

function environment(id: string): PublicKnownRuntimeEnvironment {
  return {
    id,
    name: id,
    createdAt: Date.parse('2026-10-04T09:00:00Z'),
    updatedAt: Date.parse('2026-10-04T09:00:00Z'),
    runtimeId: null,
    lastUsedAt: null,
    endpoints: [
      { id: 'websocket', kind: 'websocket', endpoint: 'ws://localhost:6768', label: 'WebSocket' }
    ],
    preferredEndpointId: 'websocket'
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('runtime catalog refresh without host probes', () => {
  it('discovers CLI additions and removals without requiring a status reader', async () => {
    let current: readonly PublicKnownRuntimeEnvironment[] = [environment('old-server')]
    const list = vi.fn().mockResolvedValue([environment('new-server')])
    const refresh = createRuntimeStatusHydration({
      listEnvironments: list,
      getCurrentEnvironments: () => current,
      publishEnvironments: (rows) => {
        current = rows
      },
      markCatalogSettled: vi.fn()
    })
    await refresh()
    expect(current.map((row) => row.id)).toEqual(['new-server'])
    list.mockResolvedValue([])
    await refresh()
    expect(current).toEqual([])
  })

  it('coalesces overlapping menu opens while a catalog read is pending', async () => {
    const read = deferred<PublicKnownRuntimeEnvironment[]>()
    let current: readonly PublicKnownRuntimeEnvironment[] = []
    const list = vi.fn(() => read.promise)
    const refresh = createRuntimeStatusHydration({
      listEnvironments: list,
      getCurrentEnvironments: () => current,
      publishEnvironments: (rows) => {
        current = rows
      },
      markCatalogSettled: vi.fn()
    })
    const first = refresh()
    const second = refresh()
    expect(first).toBe(second)
    expect(list).toHaveBeenCalledOnce()
    read.resolve([environment('new-server')])
    await first
    expect(current.map((row) => row.id)).toEqual(['new-server'])
  })

  it('does not overwrite a concurrent pairing edit with an older listing', async () => {
    const read = deferred<PublicKnownRuntimeEnvironment[]>()
    let current: readonly PublicKnownRuntimeEnvironment[] = []
    const publish = vi.fn((rows: readonly PublicKnownRuntimeEnvironment[]) => {
      current = rows
    })
    const list = vi
      .fn()
      .mockReturnValueOnce(read.promise)
      .mockResolvedValue([environment('new-server')])
    const refresh = createRuntimeStatusHydration({
      listEnvironments: list,
      getCurrentEnvironments: () => current,
      publishEnvironments: publish,
      markCatalogSettled: vi.fn()
    })
    const pending = refresh()
    current = [environment('new-server')]
    read.resolve([])
    await pending
    expect(list).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledExactlyOnceWith([environment('new-server')])
  })

  it('retains saved hosts when the local catalog cannot be read', async () => {
    const current = [environment('saved-server')]
    const publish = vi.fn()
    const settled = vi.fn()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const refresh = createRuntimeStatusHydration({
        listEnvironments: vi.fn().mockRejectedValue(new Error('Catalog unavailable')),
        getCurrentEnvironments: () => current,
        publishEnvironments: publish,
        markCatalogSettled: settled
      })
      await expect(refresh()).resolves.toBeUndefined()
      expect(publish).not.toHaveBeenCalled()
      expect(settled).toHaveBeenCalledOnce()
    } finally {
      log.mockRestore()
    }
  })
})
