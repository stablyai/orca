import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  refitAndRefreshAllTerminalPanes,
  registerLivePaneManager,
  resetAllTerminalWebglAtlases,
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

  it('resets atlases on every registered manager', () => {
    const first = registerManager()
    const second = registerManager()

    resetAllTerminalWebglAtlases()

    expect(first.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(second.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
  })

  it('stops resetting managers after they unregister', () => {
    const manager = registerManager()
    unregisterLivePaneManager(manager)

    resetAllTerminalWebglAtlases()

    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
  })

  it('continues resetting later managers when one manager throws', () => {
    const broken = {
      resetWebglTextureAtlases: vi.fn<() => void>(() => {
        throw new Error('pane disposed')
      })
    }
    registerLivePaneManager(broken)
    registeredManagers.push(broken)
    const healthy = registerManager()

    expect(() => resetAllTerminalWebglAtlases()).not.toThrow()

    expect(broken.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(healthy.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
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
})
