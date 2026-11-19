import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationDispatchRequest } from '../../../../../shared/notifications/notification-settings-types'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'

vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => store.getState() }
}))
vi.mock('@/lib/notifications/desktop-notification-sound', () => ({
  playDesktopNotificationSound: vi.fn(async () => false)
}))
vi.mock('@/lib/notifications/blocked-notification-fallback', () => ({
  showBlockedNotificationFallbackToast: vi.fn()
}))

const store = createTestStore()
const { dispatchTerminalNotification } = await import('./dispatch-terminal-notification')

const WORKSPACE = 'repo1::/tmp/wt'
const OTHER_WORKSPACE = 'repo1::/tmp/other'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF}`
const NOW = 1_700_000_000_000

const dispatched: NotificationDispatchRequest[] = []

function seed(muted: Record<string, boolean>): void {
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: WORKSPACE, repoId: 'repo1' }),
        makeWorktree({ id: OTHER_WORKSPACE, repoId: 'repo1' })
      ]
    },
    activeWorktreeId: OTHER_WORKSPACE,
    tabsByWorktree: {
      [WORKSPACE]: [
        makeTab({
          id: 'tab-1',
          ptyId: 'pty-1',
          worktreeId: WORKSPACE,
          title: 'codex'
        })
      ]
    },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty-1' }
      }
    },
    agentStatusByPaneKey: acceptedAgentStatuses([
      [
        PANE_KEY,
        {
          state: 'done',
          prompt: 'ship it',
          updatedAt: NOW,
          stateStartedAt: NOW,
          agentType: 'codex',
          paneKey: PANE_KEY,
          terminalTitle: 'codex',
          stateHistory: [],
          lastAssistantMessage: 'Done.'
        }
      ]
    ]),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only fields read.
    settings: { experimentalTerminalAttention: true } as GlobalSettings,
    notificationsMutedByWorktree: muted
  })
}

describe('dispatchTerminalNotification per-worktree mute', () => {
  beforeEach(() => {
    // Agent snapshots count as fresh only relative to the clock.
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    dispatched.length = 0
    vi.stubGlobal('window', {
      api: {
        notifications: {
          dispatch: async (request: NotificationDispatchRequest) => {
            dispatched.push(request)
            return { delivered: true }
          }
        }
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('marks the worktree unread but sends no notification while muted', () => {
    seed({ [WORKSPACE]: true })

    const requested = dispatchTerminalNotification(WORKSPACE, {
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: PANE_KEY
    })

    expect(requested).toBe(false)
    expect(dispatched).toEqual([])
    expect(store.getState().worktreesByRepo.repo1?.[0]?.isUnread).toBe(true)
  })
})
