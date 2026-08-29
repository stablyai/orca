// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { PaneManager } from './pane-manager'

function createManager(initiallyVisible: boolean): PaneManager {
  const manager = new PaneManager(document.createElement('div'), {
    linkOpenHint: () => '',
    initialRenderingSuspended: !initiallyVisible
  })
  vi.spyOn(manager, 'refreshAllPanes').mockImplementation(() => {})
  return manager
}

describe('hidden atlas invalidation debt', () => {
  it('repaints on reveal when a wipe ran while hidden', () => {
    const manager = createManager(false)

    manager.markAtlasInvalidatedWhileHidden()
    manager.setAtlasRecoveryVisible(true)

    expect(manager.refreshAllPanes).toHaveBeenCalledOnce()
  })

  it('does not repaint on reveal when no wipe ran while hidden', () => {
    // Why: reveal has its own repaint path; an unconditional refresh here
    // would re-rasterize on every workspace switch.
    const manager = createManager(false)

    manager.setAtlasRecoveryVisible(true)

    expect(manager.refreshAllPanes).not.toHaveBeenCalled()
  })

  it('settles the debt once, not on every later visibility change', () => {
    const manager = createManager(false)

    manager.markAtlasInvalidatedWhileHidden()
    manager.setAtlasRecoveryVisible(true)
    manager.setAtlasRecoveryVisible(false)
    manager.setAtlasRecoveryVisible(true)

    expect(manager.refreshAllPanes).toHaveBeenCalledOnce()
  })

  it('keeps the debt while still hidden', () => {
    const manager = createManager(false)

    manager.markAtlasInvalidatedWhileHidden()
    manager.setAtlasRecoveryVisible(false)

    expect(manager.refreshAllPanes).not.toHaveBeenCalled()

    manager.setAtlasRecoveryVisible(true)
    expect(manager.refreshAllPanes).toHaveBeenCalledOnce()
  })
})
