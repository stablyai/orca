import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getLivePaneMemoryProfileCounts,
  registerLivePaneManager,
  resetAndRefreshAllTerminalWebglAtlases,
  unregisterLivePaneManager
} from './pane-manager-registry'

describe('pane manager registry', () => {
  // Unregister module-global fake managers even after failures so they cannot leak into later tests.
  const registeredManagers: { resetWebglTextureAtlases(): void }[] = []

  afterEach(() => {
    for (const manager of registeredManagers.splice(0)) {
      unregisterLivePaneManager(manager)
    }
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

  it('clears hidden atlases without painting them only when asked to include hidden managers', () => {
    const createManager = (visible: boolean) => ({
      resetWebglTextureAtlases: vi.fn<() => void>(),
      clearWebglTextureAtlases: vi.fn<() => void>(),
      presentViewports: vi.fn<() => void>(),
      isVisibleForAtlasRecovery: () => visible
    })
    const visible = createManager(true)
    const hidden = createManager(false)
    for (const manager of [visible, hidden]) {
      registerLivePaneManager(manager)
      registeredManagers.push(manager)
    }

    resetAndRefreshAllTerminalWebglAtlases('test')
    expect(hidden.clearWebglTextureAtlases).not.toHaveBeenCalled()

    resetAndRefreshAllTerminalWebglAtlases('test', { includeHidden: true })
    expect(hidden.clearWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(hidden.presentViewports).not.toHaveBeenCalled()
    expect(visible.clearWebglTextureAtlases).toHaveBeenCalledTimes(2)
    expect(visible.presentViewports).toHaveBeenCalledTimes(2)
  })
})
