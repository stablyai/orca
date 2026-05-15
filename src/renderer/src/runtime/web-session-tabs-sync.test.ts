import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { TerminalTab } from '../../../shared/types'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

const WT = 'repo::/worktree'
const ENV = 'web-env-1'
const NOW = 1_700_000_000_000

function makeState(overrides: Partial<WebSessionTabsSyncState> = {}): WebSessionTabsSyncState {
  return {
    activeGroupIdByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeWorktreeId: WT,
    groupsByWorktree: {},
    layoutByWorktree: {},
    ptyIdsByTabId: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    unreadTerminalTabs: {},
    ...overrides
  }
}

function makeSnapshot(
  tabs: RuntimeMobileSessionTabsResult['tabs'],
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'host-group-1',
    activeTabId: tabs.find((tab) => tab.type === 'terminal' && tab.isActive)?.id ?? null,
    activeTabType: 'terminal',
    tabs,
    ...overrides
  }
}

describe('applyWebSessionTabsSnapshot', () => {
  it('hydrates ready host terminal surfaces as remote runtime terminal tabs', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: 'host-tab-1::pane:1',
          title: 'host shell',
          parentTabId: 'host-tab-1',
          leafId: 'pane:1',
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]).toMatchObject([
      {
        id: 'host-tab-1::pane:1',
        ptyId: 'remote:web-env-1@@terminal-1',
        title: 'host shell',
        worktreeId: WT
      }
    ])
    expect(patch.ptyIdsByTabId?.['host-tab-1::pane:1']).toEqual(['remote:web-env-1@@terminal-1'])
    expect(patch.groupsByWorktree?.[WT]?.[0]).toMatchObject({
      id: 'host-group-1',
      activeTabId: 'host-tab-1::pane:1',
      tabOrder: ['host-tab-1::pane:1']
    })
    expect(patch.activeTabId).toBe('host-tab-1::pane:1')
    expect(patch.activeTabIdByWorktree?.[WT]).toBe('host-tab-1::pane:1')
  })

  it('replaces temporary web-created tabs once the host publishes the same PTY', () => {
    const localTab: TerminalTab = {
      id: 'local-web-tab',
      ptyId: 'remote:web-env-1@@terminal-1',
      worktreeId: WT,
      title: 'local shell',
      defaultTitle: 'local shell',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW - 1
    }
    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [localTab] },
        ptyIdsByTabId: { 'local-web-tab': ['remote:web-env-1@@terminal-1'] },
        terminalLayoutsByTabId: {
          'local-web-tab': { root: null, activeLeafId: null, expandedLeafId: null }
        },
        unreadTerminalTabs: { 'local-web-tab': true }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: 'host-tab-1::pane:1',
          title: 'host shell',
          parentTabId: 'host-tab-1',
          leafId: 'pane:1',
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.map((tab) => tab.id)).toEqual(['host-tab-1::pane:1'])
    expect(patch.ptyIdsByTabId?.['local-web-tab']).toBeUndefined()
    expect(patch.unreadTerminalTabs?.['local-web-tab']).toBeUndefined()
  })

  it('ignores pending terminal handles so the web client does not spawn duplicates', () => {
    const state = makeState()
    const result = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([
        {
          type: 'terminal',
          id: 'host-tab-1::pane:1',
          title: 'pending shell',
          parentTabId: 'host-tab-1',
          leafId: 'pane:1',
          isActive: true,
          status: 'pending-handle',
          terminal: null
        }
      ]),
      ENV,
      NOW
    )

    expect(result).toBe(state)
  })
})
