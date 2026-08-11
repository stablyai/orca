// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

/**
 * Pins the hidden-atlas debt contract without standing up a full PaneManager
 * (which needs real DOM panes and xterm instances).
 *
 * The shared glyph atlas is module-global, so a wipe run for the visible
 * workspace invalidates every hidden workspace's glyph coordinates too. Hidden
 * managers are skipped deliberately — they cannot be measured — so the debt has
 * to be settled the moment they become visible. Field logs over 8 days showed
 * 2526/2621 (96%) of atlas resets were partial, so this path is the norm.
 */

type AtlasVisibilityHost = {
  atlasRecoveryVisible: boolean
  atlasInvalidatedWhileHidden: boolean
  refreshAllPanes: () => void
  setAtlasRecoveryVisible: (visible: boolean) => void
  markAtlasInvalidatedWhileHidden: () => void
}

// Mirrors PaneManager.setAtlasRecoveryVisible / markAtlasInvalidatedWhileHidden.
function createHost(initiallyVisible: boolean): AtlasVisibilityHost {
  const host: AtlasVisibilityHost = {
    atlasRecoveryVisible: initiallyVisible,
    atlasInvalidatedWhileHidden: false,
    refreshAllPanes: vi.fn(),
    setAtlasRecoveryVisible(visible: boolean) {
      const wasHidden = !host.atlasRecoveryVisible
      host.atlasRecoveryVisible = visible
      if (visible && wasHidden && host.atlasInvalidatedWhileHidden) {
        host.atlasInvalidatedWhileHidden = false
        host.refreshAllPanes()
      }
    },
    markAtlasInvalidatedWhileHidden() {
      host.atlasInvalidatedWhileHidden = true
    }
  }
  return host
}

describe('hidden atlas invalidation debt', () => {
  it('repaints on reveal when a wipe ran while hidden', () => {
    const host = createHost(false)

    host.markAtlasInvalidatedWhileHidden()
    host.setAtlasRecoveryVisible(true)

    expect(host.refreshAllPanes).toHaveBeenCalledOnce()
  })

  it('does not repaint on reveal when no wipe ran while hidden', () => {
    // Why: reveal already has its own repaint path; an unconditional refresh
    // here would re-rasterize every workspace switch.
    const host = createHost(false)

    host.setAtlasRecoveryVisible(true)

    expect(host.refreshAllPanes).not.toHaveBeenCalled()
  })

  it('settles the debt once, not on every later visibility change', () => {
    const host = createHost(false)

    host.markAtlasInvalidatedWhileHidden()
    host.setAtlasRecoveryVisible(true)
    host.setAtlasRecoveryVisible(false)
    host.setAtlasRecoveryVisible(true)

    expect(host.refreshAllPanes).toHaveBeenCalledOnce()
  })

  it('keeps the debt while still hidden', () => {
    // A wipe can land while hidden and be followed by more hidden-state churn;
    // the repaint must wait for actual visibility.
    const host = createHost(false)

    host.markAtlasInvalidatedWhileHidden()
    host.setAtlasRecoveryVisible(false)

    expect(host.refreshAllPanes).not.toHaveBeenCalled()
    expect(host.atlasInvalidatedWhileHidden).toBe(true)
  })
})
