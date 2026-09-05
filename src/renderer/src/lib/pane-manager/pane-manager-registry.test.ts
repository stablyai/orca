import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { collectRendererMemoryProfileCounts } from '../renderer-memory-profile'
import {
  forEachLivePaneForDesyncSentinel,
  getLivePaneCensus,
  getLivePaneMemoryProfileCounts,
  refitAndRefreshAllTerminalPanes,
  registerLivePaneManager,
  resetAndRefreshAllTerminalWebglAtlases,
  unregisterLivePaneManager
} from './pane-manager-registry'

describe('pane manager registry', () => {
  // Why: the registry is module-global; unregister in afterEach so a failed
  // assertion cannot leak fake managers into later tests.
  const registeredManagers: { resetWebglTextureAtlases(): void }[] = []

  function registerManager(): { resetWebglTextureAtlases: Mock<() => void> } {
    const manager = { resetWebglTextureAtlases: vi.fn<() => void>() }
    registerLivePaneManager(manager)
    registeredManagers.push(manager)
    return manager
  }

  afterEach(() => {
    for (const manager of registeredManagers.splice(0)) {
      unregisterLivePaneManager(manager)
    }
  })

  it('stops resetting managers after they unregister', () => {
    const manager = registerManager()
    unregisterLivePaneManager(manager)

    resetAndRefreshAllTerminalWebglAtlases()

    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
  })

  it('refreshes managers after all atlas resets complete', () => {
    const order: string[] = []
    const first = {
      resetWebglTextureAtlases: vi.fn<() => void>(() => order.push('first-reset')),
      refreshAllPanes: vi.fn<() => void>(() => order.push('first-refresh'))
    }
    const second = {
      resetWebglTextureAtlases: vi.fn<() => void>(() => order.push('second-reset')),
      refreshAllPanes: vi.fn<() => void>(() => order.push('second-refresh'))
    }
    registerLivePaneManager(first)
    registeredManagers.push(first)
    registerLivePaneManager(second)
    registeredManagers.push(second)

    resetAndRefreshAllTerminalWebglAtlases()

    expect(order).toEqual(['first-reset', 'second-reset', 'first-refresh', 'second-refresh'])
  })

  it('clears every recovered atlas before presenting any pane', () => {
    // Why: per-pane clear+present interleaves a present against atlas generation
    // N with the next pane's wipe to N+1. The first synchronized-output column
    // then keeps pre-hide footer pixels. Wipe first, present once the generation
    // is final.
    const order: string[] = []
    const first = {
      resetWebglTextureAtlases: vi.fn<() => void>(() => order.push('first-reset')),
      clearWebglTextureAtlases: vi.fn<() => void>(() => order.push('first-clear')),
      presentForcedViewports: vi.fn<() => void>(() => order.push('first-present')),
      refreshAllPanes: vi.fn<() => void>(() => order.push('first-refresh')),
      isVisibleForAtlasRecovery: () => true
    }
    const second = {
      resetWebglTextureAtlases: vi.fn<() => void>(() => order.push('second-reset')),
      clearWebglTextureAtlases: vi.fn<() => void>(() => order.push('second-clear')),
      presentForcedViewports: vi.fn<() => void>(() => order.push('second-present')),
      refreshAllPanes: vi.fn<() => void>(() => order.push('second-refresh')),
      isVisibleForAtlasRecovery: () => true
    }
    registerLivePaneManager(first)
    registeredManagers.push(first)
    registerLivePaneManager(second)
    registeredManagers.push(second)

    resetAndRefreshAllTerminalWebglAtlases()

    expect(order).toEqual(['first-clear', 'second-clear', 'first-present', 'second-present'])
    expect(first.resetWebglTextureAtlases).not.toHaveBeenCalled()
    expect(second.refreshAllPanes).not.toHaveBeenCalled()
  })

  it('bounds atlas recovery to visible managers', () => {
    const visible = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      clearWebglTextureAtlases: vi.fn<() => void>(),
      presentForcedViewports: vi.fn<() => void>(),
      refreshAllPanes: vi.fn<() => void>(),
      isVisibleForAtlasRecovery: () => true
    }
    registerLivePaneManager(visible)
    registeredManagers.push(visible)
    const hidden = Array.from({ length: 64 }, () => ({
      resetWebglTextureAtlases: vi.fn<() => void>(),
      clearWebglTextureAtlases: vi.fn<() => void>(),
      presentForcedViewports: vi.fn<() => void>(),
      refreshAllPanes: vi.fn<() => void>(),
      isVisibleForAtlasRecovery: () => false
    }))
    for (const manager of hidden) {
      registerLivePaneManager(manager)
      registeredManagers.push(manager)
    }

    resetAndRefreshAllTerminalWebglAtlases()

    expect(visible.clearWebglTextureAtlases).toHaveBeenCalledOnce()
    expect(visible.presentForcedViewports).toHaveBeenCalledOnce()
    expect(
      hidden.every((manager) => manager.clearWebglTextureAtlases.mock.calls.length === 0)
    ).toBe(true)
    expect(hidden.every((manager) => manager.presentForcedViewports.mock.calls.length === 0)).toBe(
      true
    )
  })

  it('continues reset-and-refresh recovery when one manager throws', () => {
    const broken = {
      resetWebglTextureAtlases: vi.fn<() => void>(() => {
        throw new Error('pane disposed')
      }),
      refreshAllPanes: vi.fn<() => void>()
    }
    registerLivePaneManager(broken)
    registeredManagers.push(broken)
    const healthy = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      refreshAllPanes: vi.fn<() => void>()
    }
    registerLivePaneManager(healthy)
    registeredManagers.push(healthy)

    expect(() => resetAndRefreshAllTerminalWebglAtlases()).not.toThrow()

    expect(broken.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(broken.refreshAllPanes).not.toHaveBeenCalled()
    expect(healthy.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(healthy.refreshAllPanes).toHaveBeenCalledTimes(1)
  })

  it('fits and refreshes every registered manager', () => {
    const first = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      fitAllPanes: vi.fn<() => void>(),
      refreshAllPanes: vi.fn<() => void>()
    }
    const second = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      fitAllPanes: vi.fn<() => void>(),
      refreshAllPanes: vi.fn<() => void>()
    }
    registerLivePaneManager(first)
    registeredManagers.push(first)
    registerLivePaneManager(second)
    registeredManagers.push(second)

    refitAndRefreshAllTerminalPanes()

    expect(first.fitAllPanes).toHaveBeenCalledTimes(1)
    expect(first.refreshAllPanes).toHaveBeenCalledTimes(1)
    expect(second.fitAllPanes).toHaveBeenCalledTimes(1)
    expect(second.refreshAllPanes).toHaveBeenCalledTimes(1)
  })

  it('continues refitting later managers when one manager throws', () => {
    const broken = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      fitAllPanes: vi.fn<() => void>(() => {
        throw new Error('pane disposed')
      }),
      refreshAllPanes: vi.fn<() => void>()
    }
    registerLivePaneManager(broken)
    registeredManagers.push(broken)
    const healthy = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      fitAllPanes: vi.fn<() => void>(),
      refreshAllPanes: vi.fn<() => void>()
    }
    registerLivePaneManager(healthy)
    registeredManagers.push(healthy)

    expect(() => refitAndRefreshAllTerminalPanes()).not.toThrow()

    expect(broken.fitAllPanes).toHaveBeenCalledTimes(1)
    expect(broken.refreshAllPanes).not.toHaveBeenCalled()
    expect(healthy.fitAllPanes).toHaveBeenCalledTimes(1)
    expect(healthy.refreshAllPanes).toHaveBeenCalledTimes(1)
  })

  it('keeps pane keys stable when an earlier manager unregisters', () => {
    const first = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPanes: () => [{ id: 1, terminal: {} }]
    }
    const second = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPanes: () => [{ id: 1, terminal: {} }]
    }
    registerLivePaneManager(first)
    registeredManagers.push(first)
    registerLivePaneManager(second)
    registeredManagers.push(second)
    const before: string[] = []
    forEachLivePaneForDesyncSentinel((paneKey) => before.push(paneKey))

    unregisterLivePaneManager(first)
    const after: string[] = []
    forEachLivePaneForDesyncSentinel((paneKey) => after.push(paneKey))

    expect(before).toHaveLength(2)
    expect(after).toEqual([before[1]])
  })

  // Why: this is the number crash reports could never recover from breadcrumb
  // multiplicity, since every manager's first pane is id 1.
  it('counts panes across managers and drops them on unregister', () => {
    const twoPanes = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPanes: () => [
        { id: 1, terminal: {} },
        { id: 2, terminal: {} }
      ]
    }
    const onePane = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPanes: () => [{ id: 1, terminal: {} }]
    }
    registerLivePaneManager(twoPanes)
    registeredManagers.push(twoPanes)
    registerLivePaneManager(onePane)
    registeredManagers.push(onePane)

    expect(getLivePaneCensus()).toEqual({ managers: 2, panes: 3 })

    unregisterLivePaneManager(twoPanes)
    expect(getLivePaneCensus()).toEqual({ managers: 1, panes: 1 })
  })

  it('prefers the allocation-free pane count when a manager exposes one', () => {
    const counted = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPaneCount: () => 4,
      getPanes: vi.fn(() => [{ id: 1, terminal: {} }])
    }
    registerLivePaneManager(counted)
    registeredManagers.push(counted)

    expect(getLivePaneCensus()).toEqual({ managers: 1, panes: 4 })
    expect(counted.getPanes).not.toHaveBeenCalled()
  })

  it('counts surviving managers when one throws mid-teardown', () => {
    const broken = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPanes: () => {
        throw new Error('disposed')
      }
    }
    const healthy = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPanes: () => [{ id: 1, terminal: {} }]
    }
    registerLivePaneManager(broken)
    registeredManagers.push(broken)
    registerLivePaneManager(healthy)
    registeredManagers.push(healthy)

    expect(getLivePaneCensus()).toEqual({ managers: 2, panes: 1 })
  })

  it('estimates scrollback bytes from pane buffers, skipping non-buffer terminals', () => {
    // 5000 rows x 200 cols x 16B/cell = 15.6MB -> 15625KB.
    const buffered = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPanes: () => [
        { id: 1, terminal: { cols: 200, buffer: { active: { length: 5000 } } } },
        { id: 2, terminal: {} }
      ]
    }
    registerLivePaneManager(buffered)
    registeredManagers.push(buffered)

    expect(getLivePaneMemoryProfileCounts()).toEqual({
      managers: 1,
      estPanes: 2,
      estBufferKB: 15_625
    })
  })

  it('bounds manager and pane sampling while extrapolating totals', () => {
    let sampledPaneWrappers = 0
    const managers = Array.from({ length: 100 }, () => ({
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPaneCount: vi.fn(() => 100),
      getPanes: vi.fn((limit = 100) => {
        const count = Math.min(limit, 100)
        sampledPaneWrappers += count
        return Array.from({ length: count }, (_, id) => ({
          id,
          terminal: { cols: 100, buffer: { active: { length: 64 } } }
        }))
      })
    }))
    for (const manager of managers) {
      registerLivePaneManager(manager)
      registeredManagers.push(manager)
    }

    expect(getLivePaneMemoryProfileCounts()).toEqual({
      managers: 100,
      estPanes: 10_000,
      estBufferKB: 1_000_000
    })
    expect(managers.reduce((sum, manager) => sum + manager.getPaneCount.mock.calls.length, 0)).toBe(
      64
    )
    expect(managers.reduce((sum, manager) => sum + manager.getPanes.mock.calls.length, 0)).toBe(3)
    expect(sampledPaneWrappers).toBe(256)
    expect(managers[0].getPanes).toHaveBeenCalledWith(256)
    expect(managers[1].getPanes).toHaveBeenCalledWith(156)
    expect(managers[2].getPanes).toHaveBeenCalledWith(56)
    expect(managers[3].getPanes).not.toHaveBeenCalled()
  })

  it('contributes the pane census to renderer memory profile counts', () => {
    const manager = {
      resetWebglTextureAtlases: vi.fn<() => void>(),
      getPanes: () => [{ id: 1, terminal: { cols: 100, buffer: { active: { length: 64 } } } }]
    }
    registerLivePaneManager(manager)
    registeredManagers.push(manager)

    const counts = collectRendererMemoryProfileCounts()
    expect(counts['terminals.managers']).toBe(1)
    expect(counts['terminals.estPanes']).toBe(1)
    expect(counts['terminals.estBufferKB']).toBe(100)
  })
})
