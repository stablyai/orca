import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
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
})
