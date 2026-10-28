/**
 * STA-12043, client half: once a restored host starts a new shell in a pane, it publishes the old
 * run's row as unverifiable. The paired client must replace its copy of the old Done with no tab
 * status, yet native chat must still find the conversation through the row's provider session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { getDefaultSettings } from '../../../shared/constants'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import { applyFreshWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'
import { resolveTerminalTabActivityStatus } from '../components/tab-bar/terminal-tab-activity-status'
import { resolveNativeChatSession } from '../components/native-chat/native-chat-pane-resolution'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {})
  }
}))

const WT = 'repo1::/path/wt1'
const ENV = 'remote-env-1'
const HOST_TAB = 'host-tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const SESSION = { key: 'session_id' as const, id: 'pre-restart-session' }
const T0 = 1_700_000_000_000

function hostSnapshot(
  snapshotVersion: number,
  agentStatus: { updatedAt: number; restoredUnconfirmed?: true }
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'host-epoch-1',
    snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: `${HOST_TAB}::${LEAF}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `${HOST_TAB}::${LEAF}`,
        title: 'zsh',
        parentTabId: HOST_TAB,
        leafId: LEAF,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1',
        agentStatus: {
          state: 'done',
          prompt: '',
          stateStartedAt: agentStatus.updatedAt,
          agentType: 'codex',
          paneKey: makePaneKey(HOST_TAB, LEAF),
          tabId: HOST_TAB,
          worktreeId: WT,
          stateHistory: [],
          providerSession: SESSION,
          ...agentStatus
        }
      }
    ]
  }
}

describe('a host row published unverifiable after a cold restore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetWebSessionTabsSnapshotFreshnessForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('replaces the mirrored Done with no tab status and keeps the session', () => {
    const store = createTestStore()
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
      worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
      activeWorktreeId: WT
    })
    const mirroredTabId = toWebTerminalSurfaceTabId(HOST_TAB)
    const paneKey = makePaneKey(mirroredTabId, LEAF)
    const tabStatus = (): string => {
      const state = store.getState()
      return resolveTerminalTabActivityStatus({
        tab: { id: mirroredTabId, title: 'zsh' },
        agentStatusByPaneKey: state.agentStatusByPaneKey
      })
    }

    store.setState(
      applyFreshWebSessionTabsSnapshot(
        store.getState(),
        hostSnapshot(1, { updatedAt: T0 }),
        ENV,
        T0
      )
    )
    expect(tabStatus()).toBe('done')

    vi.setSystemTime(T0 + 60_000)
    store.setState(
      applyFreshWebSessionTabsSnapshot(
        store.getState(),
        hostSnapshot(2, { updatedAt: T0 + 30_000, restoredUnconfirmed: true }),
        ENV,
        T0 + 60_000
      )
    )

    expect(tabStatus()).not.toBe('done')
    expect(
      resolveNativeChatSession({
        paneKey,
        agentStatusEntry: store.getState().agentStatusByPaneKey[paneKey],
        ptyId: null
      })?.sessionId
    ).toBe(SESSION.id)
  })
})
