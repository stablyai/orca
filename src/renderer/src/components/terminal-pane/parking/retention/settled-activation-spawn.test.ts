import { describe, expect, it } from 'vitest'
import { canParkTerminalWorktreeRenderers } from './terminal-hidden-view-parking'
import { isTerminalActivationSpawnSettled } from './settled-activation-spawn'

const worktreeId = 'repo::/work/wt-1'

function canPark(state: Parameters<typeof isTerminalActivationSpawnSettled>[0]): boolean {
  return canParkTerminalWorktreeRenderers({
    worktreeId,
    terminalTabs: [{ id: 'tab-1', ptyId: `${worktreeId}@@a1`, pendingActivationSpawn: 2 }],
    pendingStartupByTabId: {},
    parkingEnabled: true,
    isVisible: false,
    shouldMeasureHiddenWorktree: false,
    hasActivityTerminalPortal: false,
    hiddenSinceMs: 0,
    nowMs: 60_000,
    isActivationSpawnSettled: (tabId) => isTerminalActivationSpawnSettled(state, tabId)
  })
}

describe('restored terminal tabs and hidden-workspace parking', () => {
  it('parks a restored split tab once every pane has a live PTY', () => {
    expect(
      canPark({
        ptyIdsByTabId: { 'tab-1': [`${worktreeId}@@a1`, `${worktreeId}@@b2`] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            ptyIdsByLeafId: { 'leaf-a': `${worktreeId}@@a1`, 'leaf-b': `${worktreeId}@@b2` }
          }
        }
      })
    ).toBe(true)
  })

  it('keeps a restored terminal shown as chat mounted so its reader position survives', () => {
    expect(
      canPark({
        ptyIdsByTabId: { 'tab-1': [`${worktreeId}@@a1`] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            chatLeafId: 'leaf-a',
            ptyIdsByLeafId: { 'leaf-a': `${worktreeId}@@a1` }
          }
        }
      })
    ).toBe(false)
  })

  it('keeps it mounted while one pane still waits for its first spawn', () => {
    expect(
      canPark({
        ptyIdsByTabId: { 'tab-1': [`${worktreeId}@@a1`] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            ptyIdsByLeafId: { 'leaf-a': `${worktreeId}@@a1`, 'leaf-b': `${worktreeId}@@b2` }
          }
        }
      })
    ).toBe(false)
  })
})
