import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { resolveHostSessionTabIdForWebSessionTab } from './web-session-tabs-sync/tracking-mappings'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import { createStore } from 'zustand/vanilla'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

function terminalSnapshot(hostTabId: string) {
  return makeSnapshot([
    {
      type: 'terminal',
      id: `${hostTabId}::${LEAF_ID}`,
      parentTabId: hostTabId,
      leafId: LEAF_ID,
      title: hostTabId,
      isActive: true,
      status: 'ready',
      terminal: `${hostTabId}-pty`
    }
  ])
}

function apply(
  state: WebSessionTabsSyncState,
  snapshot: ReturnType<typeof makeSnapshot>,
  environmentId: string
): WebSessionTabsSyncState {
  return { ...state, ...applyWebSessionTabsSnapshot(state, snapshot, environmentId, NOW) }
}

describe('session snapshot host isolation', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('keeps WSL terminals and bindings when a Mac publishes an empty same-ID workspace', () => {
    const wsl = apply(makeState(), terminalSnapshot('wsl-tab'), 'wsl')
    const next = apply(wsl, makeSnapshot([]), 'mac')

    expect(next.tabsByWorktree[WT]).toEqual(wsl.tabsByWorktree[WT])
    expect(next.unifiedTabsByWorktree[WT]).toEqual(wsl.unifiedTabsByWorktree[WT])
    expect(next.ptyIdsByTabId).toEqual(wsl.ptyIdsByTabId)
    expect(next.terminalLayoutsByTabId).toEqual(wsl.terminalLayoutsByTabId)
  })

  it.each([
    { reverse: true, bound: true },
    { reverse: false, bound: true },
    { reverse: true, bound: false },
    { reverse: false, bound: false }
  ])('preserves conflicting legacy owners regardless of row order (%j)', ({ reverse, bound }) => {
    const wsl = apply(makeState(), terminalSnapshot('shared-tab'), 'wsl')
    const original = wsl.unifiedTabsByWorktree[WT]![0]!
    const rows = [
      original,
      { ...original, id: 'legacy-mac-alias', executionHostId: 'runtime:mac' as const }
    ]
    const originalTerminal = wsl.tabsByWorktree[WT]![0]!
    const corrupted = {
      ...wsl,
      tabsByWorktree: {
        [WT]: [{ ...originalTerminal, ptyId: bound ? originalTerminal.ptyId : null }]
      },
      unifiedTabsByWorktree: { [WT]: reverse ? rows.toReversed() : rows }
    }
    const next = apply(corrupted, terminalSnapshot('shared-tab'), 'mac')

    expect(next.ptyIdsByTabId).toMatchObject(wsl.ptyIdsByTabId)
    expect(next.tabsByWorktree[WT]).toContainEqual(corrupted.tabsByWorktree[WT]![0])
    expect(next.tabsByWorktree[WT]).toHaveLength(2)
  })

  it('keeps terminals from both servers, then closes only the publishing server’s tabs', () => {
    const wsl = apply(makeState(), terminalSnapshot('wsl-tab'), 'wsl')
    const both = apply(wsl, terminalSnapshot('mac-tab'), 'mac')

    expect(both.unifiedTabsByWorktree[WT]?.map((tab) => tab.executionHostId)).toEqual([
      'runtime:wsl',
      'runtime:mac'
    ])
    expect(both.tabsByWorktree[WT]).toHaveLength(2)
    const next = apply(both, makeSnapshot([]), 'mac')
    expect(next.tabsByWorktree[WT]).toEqual(wsl.tabsByWorktree[WT])
    expect(next.unifiedTabsByWorktree[WT]?.map((tab) => tab.executionHostId)).toEqual([
      'runtime:wsl'
    ])
    expect(next.ptyIdsByTabId).toEqual(wsl.ptyIdsByTabId)
  })

  it('isolates colliding terminal IDs and independently closes and reopens each host', () => {
    const wsl = apply(makeState(), terminalSnapshot('shared-tab'), 'wsl')
    const both = apply(wsl, terminalSnapshot('shared-tab'), 'mac')
    const macTab = both.unifiedTabsByWorktree[WT]!.find(
      (tab) => tab.executionHostId === 'runtime:mac'
    )!
    expect(both.tabsByWorktree[WT]).toHaveLength(2)
    expect(macTab.id).not.toBe(wsl.tabsByWorktree[WT]![0]!.id)
    expect(toHostSessionTabId(macTab.id)).toBe('shared-tab')
    expect(both.ptyIdsByTabId).toMatchObject(wsl.ptyIdsByTabId)
    expect(both.ptyIdsByTabId[macTab.id]).toEqual(['remote:mac@@shared-tab-pty'])
    const wslClosed = apply(both, makeSnapshot([]), 'wsl')
    expect(wslClosed.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([macTab.id])
    const reopened = apply(wslClosed, terminalSnapshot('shared-tab'), 'wsl')
    expect(reopened.unifiedTabsByWorktree[WT]?.map((tab) => tab.executionHostId)).toEqual([
      'runtime:mac',
      'runtime:wsl'
    ])
    expect(reopened.ptyIdsByTabId[macTab.id]).toEqual(both.ptyIdsByTabId[macTab.id])
    const macClosed = apply(reopened, makeSnapshot([]), 'mac')
    expect(macClosed.unifiedTabsByWorktree[WT]?.map((tab) => tab.executionHostId)).toEqual([
      'runtime:wsl'
    ])
  })

  it.each(['repo::/worktree', 'folder:same', 'repo::C:/worktrees/other'])(
    'keeps same-leaf statuses and pending bindings isolated in %s',
    (worktree) => {
      const snapshot = (host: string) => ({
        ...terminalSnapshot('shared-tab'),
        worktree,
        tabs: terminalSnapshot('shared-tab').tabs.map((tab) => ({
          ...tab,
          agentStatus: {
            paneKey: makePaneKey('shared-tab', LEAF_ID),
            tabId: 'shared-tab',
            worktreeId: worktree,
            agentType: 'omp' as const,
            state: 'working' as const,
            prompt: host,
            updatedAt: NOW,
            stateStartedAt: NOW,
            stateHistory: []
          }
        }))
      })
      const first = apply(makeState(), snapshot('wsl'), 'wsl')
      const both = apply(first, snapshot('mac'), 'mac')
      const macTab = both.tabsByWorktree[worktree]![1]!
      const wslTab = first.tabsByWorktree[worktree]![0]!
      expect(both.agentStatusByPaneKey[makePaneKey(wslTab.id, LEAF_ID)]?.prompt).toBe('wsl')
      expect(both.agentStatusByPaneKey[makePaneKey(macTab.id, LEAF_ID)]?.prompt).toBe('mac')
      expect(
        resolveHostSessionTabIdForWebSessionTab(both, {
          environmentId: 'mac',
          worktreeId: worktree,
          tabId: macTab.id
        })
      ).toBe('shared-tab')
      const pending = apply(
        both,
        {
          ...snapshot('mac'),
          tabs: snapshot('mac').tabs.map((tab) => ({
            ...tab,
            status: 'pending-handle' as const,
            terminal: null
          }))
        },
        'mac'
      )
      expect(pending.tabsByWorktree[worktree]![1]!.id).toBe(macTab.id)
      expect(pending.ptyIdsByTabId).toEqual(both.ptyIdsByTabId)
      const closed = apply(pending, { ...makeSnapshot([]), worktree }, 'wsl')
      expect(closed.agentStatusByPaneKey[makePaneKey(wslTab.id, LEAF_ID)]).toBeUndefined()
      expect(closed.agentStatusByPaneKey[makePaneKey(macTab.id, LEAF_ID)]?.prompt).toBe('mac')
      const resumed = apply(closed, snapshot('mac'), 'mac')
      expect(resumed.tabsByWorktree[worktree]![0]!.id).toBe(macTab.id)
    }
  )

  it('keeps a foreign pending terminal even without a live PTY binding', () => {
    const hydrated = apply(makeState(), terminalSnapshot('wsl-tab'), 'wsl')
    const wsl = {
      ...hydrated,
      tabsByWorktree: {
        [WT]: hydrated.tabsByWorktree[WT]!.map((tab) => ({ ...tab, ptyId: null }))
      },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    }
    const next = apply(wsl, makeSnapshot([]), 'mac')
    expect(next.tabsByWorktree[WT]).toEqual(wsl.tabsByWorktree[WT])
    expect(next.unifiedTabsByWorktree[WT]).toEqual(wsl.unifiedTabsByWorktree[WT])
  })

  it.each([true, false])(
    'isolates a colliding terminal ID in another workspace (bound: %s)',
    (bound) => {
      const hydrated = apply(makeState(), terminalSnapshot('shared-tab'), 'wsl')
      const wsl = bound
        ? hydrated
        : {
            ...hydrated,
            tabsByWorktree: {},
            unifiedTabsByWorktree: {
              [WT]: hydrated.unifiedTabsByWorktree[WT]!.map((tab) => ({
                ...tab,
                id: 'canonical-alias'
              }))
            },
            ptyIdsByTabId: {},
            terminalLayoutsByTabId: {}
          }
      const otherWorktree = 'repo::/another-worktree'
      const both = apply(wsl, { ...terminalSnapshot('shared-tab'), worktree: otherWorktree }, 'mac')
      expect(both.unifiedTabsByWorktree[WT]).toEqual(wsl.unifiedTabsByWorktree[WT])
      const macTab = both.tabsByWorktree[otherWorktree]![0]!
      expect(macTab.id).not.toBe(hydrated.tabsByWorktree[WT]![0]!.id)
      expect(both.ptyIdsByTabId[macTab.id]).toEqual(['remote:mac@@shared-tab-pty'])
      expect(both.ptyIdsByTabId).toMatchObject(wsl.ptyIdsByTabId)
    }
  )

  it('still closes the publishing server’s last terminal', () => {
    const wsl = apply(makeState(), terminalSnapshot('wsl-tab'), 'wsl')
    const next = apply(wsl, makeSnapshot([]), 'wsl')
    expect(next.tabsByWorktree[WT]).toEqual([])
    expect(next.unifiedTabsByWorktree[WT]).toBeUndefined()
    expect(next.ptyIdsByTabId).toEqual({})
    expect(next.terminalLayoutsByTabId).toEqual({})
  })

  it('does not adopt a foreign provisional tab even when the incoming host names its ID', () => {
    const wsl = apply(makeState(), terminalSnapshot('wsl-tab'), 'wsl')
    const terminal = wsl.tabsByWorktree[WT]![0]!
    const provisional = {
      ...wsl,
      tabsByWorktree: { [WT]: [{ ...terminal, id: 'wsl-tab', ptyId: null }] },
      unifiedTabsByWorktree: {
        [WT]: wsl.unifiedTabsByWorktree[WT]!.map((tab) => ({
          ...tab,
          id: 'wsl-tab',
          entityId: 'wsl-tab'
        }))
      }
    }
    const both = apply(provisional, terminalSnapshot('wsl-tab'), 'mac')
    expect(both.tabsByWorktree[WT]).toContainEqual(provisional.tabsByWorktree[WT]![0])
    expect(both.unifiedTabsByWorktree[WT]).toContainEqual(provisional.unifiedTabsByWorktree[WT]![0])
    expect(both.tabsByWorktree[WT]).toHaveLength(2)
  })

  it('does not wake subscribers when an unrelated host repeatedly publishes empty frames', () => {
    const store = createStore<WebSessionTabsSyncState>(() =>
      apply(makeState(), terminalSnapshot('wsl-tab'), 'wsl')
    )
    const notified = vi.fn()
    store.subscribe(notified)
    const initial = store.getState()
    for (let version = 1; version <= 128; version++) {
      store.setState((state) =>
        applyWebSessionTabsSnapshot(
          state,
          makeSnapshot([], { snapshotVersion: version }),
          'mac',
          NOW + version
        )
      )
    }
    expect(notified).not.toHaveBeenCalled()
    expect(store.getState()).toBe(initial)
  })
})
