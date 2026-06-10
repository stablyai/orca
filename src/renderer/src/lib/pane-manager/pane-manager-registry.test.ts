import { describe, expect, it, vi } from 'vitest'
import {
  registerLivePaneManager,
  resetAllTerminalWebglAtlases,
  unregisterLivePaneManager
} from './pane-manager-registry'

describe('pane manager registry', () => {
  it('resets atlases on every registered manager', () => {
    const first = { resetWebglTextureAtlases: vi.fn() }
    const second = { resetWebglTextureAtlases: vi.fn() }
    registerLivePaneManager(first)
    registerLivePaneManager(second)

    resetAllTerminalWebglAtlases()

    expect(first.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    expect(second.resetWebglTextureAtlases).toHaveBeenCalledTimes(1)
    unregisterLivePaneManager(first)
    unregisterLivePaneManager(second)
  })

  it('stops resetting managers after they unregister', () => {
    const manager = { resetWebglTextureAtlases: vi.fn() }
    registerLivePaneManager(manager)
    unregisterLivePaneManager(manager)

    resetAllTerminalWebglAtlases()

    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
  })
})
