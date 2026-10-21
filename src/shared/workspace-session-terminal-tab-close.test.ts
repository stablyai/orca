import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import type { Tab } from './tab-types'
import type { TerminalTab } from './terminal-tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { closeTerminalTabInWorkspaceSession } from './workspace-session-terminal-tab-close'

const WORKTREE_ID = 'worktree-1'

function terminalTab(id: string, ptyId: string | null, isPinned = false): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    isPinned,
    sortOrder: 0,
    createdAt: 1
  }
}

function unifiedTab(
  id: string,
  entityId: string,
  contentType: Tab['contentType'],
  groupId = 'group-1',
  isPinned = false
): Tab {
  return {
    id,
    entityId,
    groupId,
    worktreeId: WORKTREE_ID,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    isPinned
  }
}

function session(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: WORKTREE_ID,
    activeTabId: 'terminal-1',
    tabsByWorktree: {
      [WORKTREE_ID]: [terminalTab('terminal-1', 'pty-left')]
    },
    terminalLayoutsByTabId: {
      'terminal-1': {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: 'leaf-left' },
          second: { type: 'leaf', leafId: 'leaf-right' }
        },
        activeLeafId: 'leaf-left',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-left': 'pty-left', 'leaf-right': 'pty-right' }
      }
    },
    activeTabIdByWorktree: { [WORKTREE_ID]: 'terminal-1' },
    unifiedTabs: {
      [WORKTREE_ID]: [unifiedTab('terminal-1', 'terminal-1', 'terminal')]
    },
    tabGroups: {
      [WORKTREE_ID]: [
        {
          id: 'group-1',
          worktreeId: WORKTREE_ID,
          activeTabId: 'terminal-1',
          tabOrder: ['terminal-1'],
          recentTabIds: ['terminal-1']
        }
      ]
    },
    tabGroupLayouts: { [WORKTREE_ID]: { type: 'leaf', groupId: 'group-1' } },
    activeGroupIdByWorktree: { [WORKTREE_ID]: 'group-1' },
    defaultTerminalTabsAppliedByWorktreeId: { [WORKTREE_ID]: true },
    ...overrides
  }
}

describe('closeTerminalTabInWorkspaceSession', () => {
  it('atomically removes a dormant split tab and returns every exact PTY', () => {
    const result = closeTerminalTabInWorkspaceSession(
      session({
        remoteSessionIdsByTabId: { 'terminal-1': 'pty-remote' },
        sleepingAgentSessionsByPaneKey: {
          'terminal-1:leaf-left': {
            paneKey: 'terminal-1:leaf-left',
            tabId: 'terminal-1',
            worktreeId: WORKTREE_ID,
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'session-1' },
            prompt: 'continue',
            state: 'working',
            capturedAt: 1,
            updatedAt: 1
          }
        }
      }),
      WORKTREE_ID,
      'terminal-1'
    )

    expect(result).toMatchObject({ closed: true, pinned: false })
    expect(result.ptyIdsToKill.sort()).toEqual(['pty-left', 'pty-remote', 'pty-right'])
    expect(result.session.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(result.session.terminalLayoutsByTabId['terminal-1']).toBeUndefined()
    expect(result.session.remoteSessionIdsByTabId?.['terminal-1']).toBeUndefined()
    expect(result.session.sleepingAgentSessionsByPaneKey).toEqual({})
    expect(result.session.defaultTerminalTabsAppliedByWorktreeId?.[WORKTREE_ID]).toBe(true)
  })

  it('does not kill a PTY still owned by another terminal tab', () => {
    const current = session({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          terminalTab('terminal-1', 'shared-pty'),
          terminalTab('terminal-2', 'shared-pty')
        ]
      },
      terminalLayoutsByTabId: {
        'terminal-1': {
          root: { type: 'leaf', leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-1': 'shared-pty' }
        },
        'terminal-2': {
          root: { type: 'leaf', leafId: 'leaf-2' },
          activeLeafId: 'leaf-2',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-2': 'shared-pty' }
        }
      }
    })

    const result = closeTerminalTabInWorkspaceSession(current, WORKTREE_ID, 'terminal-1')

    expect(result.ptyIdsToKill).toEqual([])
    expect(result.session.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['terminal-2'])
  })

  it('lands on the active browser survivor instead of an empty terminal group', () => {
    const current = session({
      browserTabsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'browser-1',
            worktreeId: WORKTREE_ID,
            url: 'https://example.com',
            title: 'Docs',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      activeBrowserTabIdByWorktree: { [WORKTREE_ID]: 'browser-1' },
      unifiedTabs: {
        [WORKTREE_ID]: [
          unifiedTab('terminal-1', 'terminal-1', 'terminal'),
          unifiedTab('browser-1', 'browser-1', 'browser')
        ]
      },
      tabGroups: {
        [WORKTREE_ID]: [
          {
            id: 'group-1',
            worktreeId: WORKTREE_ID,
            activeTabId: 'terminal-1',
            tabOrder: ['terminal-1', 'browser-1'],
            recentTabIds: ['browser-1', 'terminal-1']
          }
        ]
      }
    })

    const result = closeTerminalTabInWorkspaceSession(current, WORKTREE_ID, 'terminal-1')

    expect(result.session.tabGroups?.[WORKTREE_ID]?.[0]?.activeTabId).toBe('browser-1')
    expect(result.session.activeTabTypeByWorktree?.[WORKTREE_ID]).toBe('browser')
    expect(result.session.activeBrowserTabIdByWorktree?.[WORKTREE_ID]).toBe('browser-1')
    expect(result.session.activeWorktreeId).toBe(WORKTREE_ID)
  })

  it('rejects pinned tabs without mutating the session', () => {
    const current = session({
      tabsByWorktree: { [WORKTREE_ID]: [terminalTab('terminal-1', 'pty-left', true)] }
    })

    const result = closeTerminalTabInWorkspaceSession(current, WORKTREE_ID, 'terminal-1')

    expect(result).toEqual({ session: current, ptyIdsToKill: [], closed: false, pinned: true })
  })

  it('has no bounded replay window after more than 32 closes', () => {
    let current = getDefaultWorkspaceSession()
    for (let index = 0; index < 40; index += 1) {
      const id = `terminal-${index}`
      current = {
        ...current,
        tabsByWorktree: {
          ...current.tabsByWorktree,
          [WORKTREE_ID]: [terminalTab(id, `pty-${index}`)]
        },
        terminalLayoutsByTabId: {
          ...current.terminalLayoutsByTabId,
          [id]: {
            root: { type: 'leaf', leafId: `leaf-${index}` },
            activeLeafId: `leaf-${index}`,
            expandedLeafId: null,
            ptyIdsByLeafId: { [`leaf-${index}`]: `pty-${index}` }
          }
        }
      }
      current = closeTerminalTabInWorkspaceSession(current, WORKTREE_ID, id).session
    }

    expect(current.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(current.terminalLayoutsByTabId).toEqual({})
  })
  it('selects the previous neighbor in linear work when closing the last of many tabs', () => {
    let reads = 0
    const ids = Array.from({ length: 1000 }, (_, i) => `tab-${i}`)
    const tabOrder = [...ids, 'terminal-1']
    for (let i = 0; i < tabOrder.length; i++) {
      const value = tabOrder[i]
      Object.defineProperty(tabOrder, i, {
        get: () => {
          reads++
          return value
        }
      })
    }
    const initial = session()
    initial.tabGroups![WORKTREE_ID][0].tabOrder = tabOrder
    initial.tabGroups![WORKTREE_ID][0].recentTabIds = []
    const result = closeTerminalTabInWorkspaceSession(initial, WORKTREE_ID, 'terminal-1')
    expect(result.session.tabGroups![WORKTREE_ID][0].activeTabId).toBe('tab-999')
    expect(result.session.tabGroups![WORKTREE_ID][0].tabOrder).toEqual(ids)
    expect(reads).toBeLessThan(6000)
  })

  it('preserves first-occurrence neighbor semantics for duplicate legacy order entries', () => {
    const initial = session()
    initial.tabGroups![WORKTREE_ID][0].tabOrder = ['a', 'terminal-1', 'a', 'b']
    initial.tabGroups![WORKTREE_ID][0].recentTabIds = ['absent', 'terminal-1']
    const result = closeTerminalTabInWorkspaceSession(initial, WORKTREE_ID, 'terminal-1')
    expect(result.session.tabGroups![WORKTREE_ID][0].activeTabId).toBe('b')
    expect(result.session.tabGroups![WORKTREE_ID][0].tabOrder).toEqual(['a', 'a', 'b'])
    expect(result.session.tabGroups![WORKTREE_ID][0].recentTabIds).toEqual([])
  })
  // Preserve the pre-index selection as an independent oracle: which tab takes focus after a
  // close is directly user-visible, so the indexed form must agree on every shape.
  it('matches the pre-index next-active selection across random orders, duplicates and MRU stacks', () => {
    function referenceNextActive(
      tabOrder: readonly string[],
      recentTabIds: readonly string[],
      closingId: string
    ): string | null {
      const remaining = tabOrder.filter((id) => id !== closingId)
      for (let index = recentTabIds.length - 1; index >= 0; index -= 1) {
        const id = recentTabIds[index]!
        if (remaining.includes(id)) {
          return id
        }
      }
      const closingIndex = tabOrder.indexOf(closingId)
      return remaining.find((id) => tabOrder.indexOf(id) > closingIndex) ?? remaining.at(-1) ?? null
    }

    let seed = 987654
    const random = (limit: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % limit
    }
    const pool = ['a', 'b', 'c', 'd', 'terminal-1']
    for (let sample = 0; sample < 500; sample++) {
      const tabOrder = Array.from({ length: 1 + random(6) }, () => pool[random(pool.length)]!)
      // Keep the closed tab present and at least one survivor, or the group is dropped entirely.
      tabOrder.splice(random(tabOrder.length + 1), 0, 'terminal-1')
      if (!tabOrder.some((id) => id !== 'terminal-1')) {
        tabOrder.push('a')
      }
      const recentTabIds = Array.from({ length: random(5) }, () => pool[random(pool.length)]!)

      const initial = session()
      initial.tabGroups![WORKTREE_ID]![0]!.tabOrder = [...tabOrder]
      initial.tabGroups![WORKTREE_ID]![0]!.recentTabIds = [...recentTabIds]
      initial.tabGroups![WORKTREE_ID]![0]!.activeTabId = 'terminal-1'
      const result = closeTerminalTabInWorkspaceSession(initial, WORKTREE_ID, 'terminal-1')

      expect({
        tabOrder,
        recentTabIds,
        activeTabId: result.session.tabGroups![WORKTREE_ID]![0]!.activeTabId
      }).toEqual({
        tabOrder,
        recentTabIds,
        activeTabId: referenceNextActive(tabOrder, recentTabIds, 'terminal-1')
      })
    }
  })

  it.each([
    { name: 'first of three', order: ['terminal-1', 'b', 'c'], expected: 'b' },
    { name: 'middle of three', order: ['a', 'terminal-1', 'c'], expected: 'c' },
    { name: 'last of three', order: ['a', 'b', 'terminal-1'], expected: 'b' }
  ])(
    'picks the documented neighbor with no MRU history when closing the $name',
    ({ order, expected }) => {
      const initial = session()
      initial.tabGroups![WORKTREE_ID]![0]!.tabOrder = order
      initial.tabGroups![WORKTREE_ID]![0]!.recentTabIds = []
      const result = closeTerminalTabInWorkspaceSession(initial, WORKTREE_ID, 'terminal-1')
      expect(result.session.tabGroups![WORKTREE_ID]![0]!.activeTabId).toBe(expected)
    }
  )

  it('prefers the most recent surviving tab over the order neighbor', () => {
    const initial = session()
    initial.tabGroups![WORKTREE_ID]![0]!.tabOrder = ['a', 'terminal-1', 'c']
    initial.tabGroups![WORKTREE_ID]![0]!.recentTabIds = ['c', 'a']
    const result = closeTerminalTabInWorkspaceSession(initial, WORKTREE_ID, 'terminal-1')
    expect(result.session.tabGroups![WORKTREE_ID]![0]!.activeTabId).toBe('a')
  })

  it('leaves the active tab alone when a background tab closes', () => {
    const initial = session()
    initial.tabGroups![WORKTREE_ID]![0]!.tabOrder = ['a', 'terminal-1', 'c']
    initial.tabGroups![WORKTREE_ID]![0]!.activeTabId = 'c'
    initial.tabGroups![WORKTREE_ID]![0]!.recentTabIds = ['a']
    const result = closeTerminalTabInWorkspaceSession(initial, WORKTREE_ID, 'terminal-1')
    expect(result.session.tabGroups![WORKTREE_ID]![0]!.activeTabId).toBe('c')
  })
})
