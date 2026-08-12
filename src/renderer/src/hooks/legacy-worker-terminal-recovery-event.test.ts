import { describe, expect, it, vi } from 'vitest'
import {
  resolveLegacyWorkerTerminalRecoveryAction,
  rollbackLegacyWorkerTerminalSurfaceInStore
} from './legacy-worker-terminal-recovery-event'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

describe('legacy worker terminal recovery events', () => {
  it('removes a rolled-back surface without clearing its sleeping recovery fence', () => {
    expect(
      resolveLegacyWorkerTerminalRecoveryAction({
        paneKey: `legacy-worker:${LEAF_ID}`,
        resolution: 'rolled_back',
        ptyId: 'pty-legacy'
      })
    ).toEqual({
      kind: 'rollback-surface',
      detail: {
        tabId: 'legacy-worker',
        leafId: LEAF_ID,
        preservePty: true,
        retireSurface: true,
        expectedPtyId: 'pty-legacy'
      }
    })
  })

  it('clears sleeping recovery only after an adopted or exited resolution', () => {
    expect(
      resolveLegacyWorkerTerminalRecoveryAction({
        paneKey: `legacy-worker:${LEAF_ID}`,
        resolution: 'adopted'
      })
    ).toEqual({
      kind: 'clear-sleeping',
      paneKey: `legacy-worker:${LEAF_ID}`
    })
  })

  it('removes an unmounted split surface only when its PTY identity still matches', () => {
    const setTabLayout = vi.fn()
    const clearTabPtyId = vi.fn()
    const closeTab = vi.fn()
    const retireAgentPaneAuthority = vi.fn()
    const siblingLeafId = '22222222-2222-4222-8222-222222222222'
    const store = {
      tabsByWorktree: {
        worktree: [{ id: 'legacy-worker' }]
      },
      terminalLayoutsByTabId: {
        'legacy-worker': {
          root: {
            type: 'split' as const,
            direction: 'horizontal' as const,
            ratio: 0.5,
            first: { type: 'leaf' as const, leafId: LEAF_ID },
            second: { type: 'leaf' as const, leafId: siblingLeafId }
          },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [LEAF_ID]: 'pty-legacy',
            [siblingLeafId]: 'pty-sibling'
          }
        }
      },
      setTabLayout,
      clearTabPtyId,
      closeTab,
      retireAgentPaneAuthority
    }

    expect(
      rollbackLegacyWorkerTerminalSurfaceInStore(store as never, {
        tabId: 'legacy-worker',
        leafId: LEAF_ID,
        preservePty: true,
        expectedPtyId: 'pty-legacy'
      })
    ).toBe('removed')
    expect(setTabLayout).toHaveBeenCalledWith(
      'legacy-worker',
      expect.objectContaining({
        root: { type: 'leaf', leafId: siblingLeafId },
        ptyIdsByLeafId: { [siblingLeafId]: 'pty-sibling' }
      })
    )
    expect(clearTabPtyId).toHaveBeenCalledWith('legacy-worker', 'pty-legacy')
    expect(retireAgentPaneAuthority).toHaveBeenCalledWith(`legacy-worker:${LEAF_ID}`, {
      preserveSleepingAgentSession: true
    })
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('does not remove a replacement surface that reused the same pane', () => {
    const setTabLayout = vi.fn()
    const clearTabPtyId = vi.fn()
    const closeTab = vi.fn()
    const store = {
      tabsByWorktree: {
        worktree: [{ id: 'legacy-worker' }]
      },
      terminalLayoutsByTabId: {
        'legacy-worker': {
          root: { type: 'leaf' as const, leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-replacement' }
        }
      },
      setTabLayout,
      clearTabPtyId,
      closeTab
    }

    expect(
      rollbackLegacyWorkerTerminalSurfaceInStore(store as never, {
        tabId: 'legacy-worker',
        leafId: LEAF_ID,
        preservePty: true,
        expectedPtyId: 'pty-legacy'
      })
    ).toBe('identity-mismatch')
    expect(setTabLayout).not.toHaveBeenCalled()
    expect(clearTabPtyId).not.toHaveBeenCalled()
    expect(closeTab).not.toHaveBeenCalled()
  })
})
