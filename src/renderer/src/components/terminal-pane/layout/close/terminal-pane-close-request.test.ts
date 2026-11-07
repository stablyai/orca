import { describe, expect, it, vi } from 'vitest'
import {
  applyTerminalPaneCloseRequest,
  retireMountedTerminalPaneSurface,
  suppressIntentionalPaneCloseExit
} from './terminal-pane-lifecycle-close'

describe('applyTerminalPaneCloseRequest', () => {
  it('detaches a rolled-back split surface without closing its PTY', () => {
    const manager = {
      getPanes: vi.fn(() => [{ id: 1 }, { id: 2 }]),
      getNumericIdForLeaf: vi.fn(() => 2),
      closePane: vi.fn(),
      detachPaneForExternalMove: vi.fn(() => true),
      retirePanePreservingPty: vi.fn(() => true)
    }
    const closeTab = vi.fn()
    const closeTabPreservingPty = vi.fn()

    expect(
      applyTerminalPaneCloseRequest({
        detail: {
          lastPaneCloseReason: 'cleanup',
          tabId: 'legacy-worker',
          leafId: '11111111-1111-4111-8111-111111111111',
          preservePty: true
        },
        manager,
        closeTab,
        closeTabPreservingPty
      })
    ).toBe('pane')
    expect(manager.detachPaneForExternalMove).toHaveBeenCalledWith(2)
    expect(manager.closePane).not.toHaveBeenCalled()
    expect(closeTab).not.toHaveBeenCalled()
    expect(closeTabPreservingPty).not.toHaveBeenCalled()
  })

  it("closes a tab through its last pane with the requester's reason, never an implied user close", () => {
    // A withdrawn launch pane closing the tab must not reach a paired host as the user's close (#37245).
    const closeTab = vi.fn()
    const manager = {
      getPanes: vi.fn(() => [{ id: 1 }]),
      getNumericIdForLeaf: vi.fn(() => 1),
      closePane: vi.fn(),
      detachPaneForExternalMove: vi.fn(() => true),
      retirePanePreservingPty: vi.fn(() => true)
    }

    applyTerminalPaneCloseRequest({
      detail: {
        lastPaneCloseReason: 'cleanup',
        tabId: 'launch-tab',
        leafId: '11111111-1111-4111-8111-111111111111'
      },
      manager,
      closeTab,
      closeTabPreservingPty: vi.fn()
    })

    expect(closeTab).toHaveBeenCalledWith('cleanup')
  })

  it('uses non-destructive tab close semantics for the last rolled-back pane', () => {
    const closeTab = vi.fn()
    const closeTabPreservingPty = vi.fn()

    expect(
      applyTerminalPaneCloseRequest({
        detail: {
          lastPaneCloseReason: 'cleanup',
          tabId: 'legacy-worker',
          paneRuntimeId: 1,
          preservePty: true
        },
        manager: {
          getPanes: vi.fn(() => [{ id: 1 }]),
          getNumericIdForLeaf: vi.fn(() => 1),
          closePane: vi.fn(),
          detachPaneForExternalMove: vi.fn(() => true),
          retirePanePreservingPty: vi.fn(() => true)
        },
        closeTab,
        closeTabPreservingPty
      })
    ).toBe('tab')
    expect(closeTabPreservingPty).toHaveBeenCalledOnce()
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('ignores a delayed rollback after the pane PTY identity changed', () => {
    const manager = {
      getPanes: vi.fn(() => [{ id: 1 }]),
      getNumericIdForLeaf: vi.fn(() => 1),
      closePane: vi.fn(),
      detachPaneForExternalMove: vi.fn(() => true),
      retirePanePreservingPty: vi.fn(() => true)
    }
    const closeTab = vi.fn()
    const closeTabPreservingPty = vi.fn()

    expect(
      applyTerminalPaneCloseRequest({
        detail: {
          lastPaneCloseReason: 'cleanup',
          tabId: 'legacy-worker',
          leafId: '11111111-1111-4111-8111-111111111111',
          preservePty: true,
          expectedPtyId: 'pty-legacy'
        },
        manager,
        closeTab,
        closeTabPreservingPty,
        getPtyIdForLeaf: () => 'pty-replacement'
      })
    ).toBe('ignored')
    expect(manager.detachPaneForExternalMove).not.toHaveBeenCalled()
    expect(closeTabPreservingPty).not.toHaveBeenCalled()
  })

  it('retires a mounted rollback pane without detaching it as a movable surface', () => {
    const manager = {
      getPanes: vi.fn(() => [{ id: 1 }, { id: 2 }]),
      getNumericIdForLeaf: vi.fn(() => 2),
      closePane: vi.fn(),
      detachPaneForExternalMove: vi.fn(() => true),
      retirePanePreservingPty: vi.fn(() => true)
    }

    expect(
      applyTerminalPaneCloseRequest({
        detail: {
          lastPaneCloseReason: 'cleanup',
          tabId: 'legacy-worker',
          leafId: '11111111-1111-4111-8111-111111111111',
          preservePty: true,
          retireSurface: true,
          expectedPtyId: 'pty-legacy'
        },
        manager,
        closeTab: vi.fn(),
        closeTabPreservingPty: vi.fn(),
        getPtyIdForLeaf: () => 'pty-legacy'
      })
    ).toBe('pane')
    expect(manager.retirePanePreservingPty).toHaveBeenCalledWith(2)
    expect(manager.detachPaneForExternalMove).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('retires mounted authority and binding while preserving the process and sleeping fence', () => {
    const retireAgentPaneAuthority = vi.fn()
    const syncPanePtyLayoutBinding = vi.fn()
    const clearExitedPanePtyLayoutBindingForLeaf = vi.fn()
    const clearTabPtyId = vi.fn()
    const transport = { detach: vi.fn(), destroy: vi.fn() }

    retireMountedTerminalPaneSurface({
      paneKey: 'legacy-worker:11111111-1111-4111-8111-111111111111',
      leafId: '11111111-1111-4111-8111-111111111111',
      paneId: 2,
      tabId: 'legacy-worker',
      ptyId: 'pty-legacy',
      retireAgentPaneAuthority,
      syncPanePtyLayoutBinding,
      clearExitedPanePtyLayoutBindingForLeaf,
      clearTabPtyId,
      transport
    })

    expect(retireAgentPaneAuthority).toHaveBeenCalledWith(
      'legacy-worker:11111111-1111-4111-8111-111111111111',
      { preserveSleepingAgentSession: true }
    )
    expect(clearExitedPanePtyLayoutBindingForLeaf).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'pty-legacy'
    )
    expect(syncPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(clearTabPtyId).toHaveBeenCalledWith('legacy-worker', 'pty-legacy')
    expect(transport.detach).toHaveBeenCalledOnce()
    expect(transport.destroy).not.toHaveBeenCalled()
  })
})

describe('suppressIntentionalPaneCloseExit', () => {
  it('suppresses the pane PTY exit before intentional close teardown destroys the transport', () => {
    const suppressPtyExit = vi.fn()
    const transport = {
      getPtyId: vi.fn(() => 'pty-pane-2')
    }

    expect(suppressIntentionalPaneCloseExit(transport, suppressPtyExit)).toBe('pty-pane-2')
    expect(suppressPtyExit).toHaveBeenCalledWith('pty-pane-2')
  })

  it('does not suppress natural PTY exits that already cleared the transport id', () => {
    const suppressPtyExit = vi.fn()
    const transport = {
      getPtyId: vi.fn(() => null)
    }

    expect(suppressIntentionalPaneCloseExit(transport, suppressPtyExit)).toBeNull()
    expect(suppressPtyExit).not.toHaveBeenCalled()
  })
})
