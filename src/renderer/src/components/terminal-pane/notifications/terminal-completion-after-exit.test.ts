import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { setPresenceGated } from '@/hooks/agent-auto-ack-presence'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { reduceHostTurnEnd } from '../../../../../shared/agent-hook-listener/state/agent-hook-turn-end-timing'
import type { AgentHookEventPayload } from '../../../../../shared/agent-hook-listener/listener-event'
import { createHookListenerState } from '../../../../../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../../../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import {
  observeAgentHookCompletionForNotification,
  syncAgentHookCompletionNotificationSettings,
  resetAgentHookCompletionNotificationCoordinators
} from '@/hooks/agent-hook-completion-notifications'

vi.mock('@/store', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('../agent-completion/agent-hook-terminal-lifecycle', () => ({
  dispatchAgentHookTerminalLifecycle: vi.fn()
}))
vi.mock('@/lib/notifications/desktop-notification-sound', () => ({
  playDesktopNotificationSound: vi.fn()
}))
vi.mock('@/store/slices/worktrees/metadata/worktree-meta-persist', () => ({
  persistWorktreeMeta: vi.fn(async () => undefined)
}))

const store = createTestStore()
const WORKSPACE = 'repo1::/tmp/completion'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-1:${LEAF}`
const notifications = vi.fn(async () => ({ delivered: true }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  setPresenceGated(false)
  notifications.mockClear()
  vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false })
  vi.stubGlobal('window', {
    api: {
      notifications: { dispatch: notifications },
      agentStatus: {},
      github: { enqueuePRRefresh: vi.fn(async () => undefined) }
    }
  })
  store.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only notification policy fields are read.
    settings: { experimentalTerminalAttention: true } as GlobalSettings,
    repos: [{ ...TEST_REPO, executionHostId: 'local' }],
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKSPACE, repoId: 'repo1', hostId: 'local' })]
    },
    tabsByWorktree: { [WORKSPACE]: [makeTab({ id: 'tab-1', worktreeId: WORKSPACE, ptyId: null })] },
    unifiedTabsByWorktree: {
      [WORKSPACE]: [
        makeUnifiedTab({
          id: 'tab-1',
          entityId: 'tab-1',
          contentType: 'terminal',
          groupId: 'group-1',
          worktreeId: WORKSPACE,
          executionHostId: 'local'
        })
      ]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      }
    },
    ptyIdsByTabId: {},
    agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
    agentConversationsByPaneKey: {},
    activeWorktreeId: null,
    refreshGitHubForWorktreeIfStale: vi.fn(),
    unreadAgentCompletionPanes: {},
    unreadTerminalPanes: {},
    unreadTerminalTabs: {}
  })
})

afterEach(() => {
  resetAgentHookCompletionNotificationCoordinators()
  setPresenceGated(true)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('completion after the process exits with its pane still open', () => {
  it.each([
    { agent: 'claude', exitAfterDelivery: false },
    { agent: 'codex', exitAfterDelivery: false },
    { agent: 'claude', exitAfterDelivery: true },
    { agent: 'codex', exitAfterDelivery: true },
    { agent: 'claude', exitAfterDelivery: false, suppressedExit: true },
    { agent: 'codex', exitAfterDelivery: false, suppressedExit: true }
  ] as const)(
    'delivers $agent completion and keeps the workspace unread (exitAfterDelivery=$exitAfterDelivery)',
    async (scenario) => {
      const { agent, exitAfterDelivery } = scenario
      const suppressedExit = 'suppressedExit' in scenario
      store.setState({
        tabsByWorktree: {
          [WORKSPACE]: [makeTab({ id: 'tab-1', worktreeId: WORKSPACE, ptyId: 'pty-1' })]
        },
        ptyIdsByTabId: { 'tab-1': ['pty-1'] },
        terminalLayoutsByTabId: {
          'tab-1': {
            ...store.getState().terminalLayoutsByTabId['tab-1'],
            ptyIdsByLeafId: { [LEAF]: 'pty-1' }
          }
        }
      })
      const listener = createHookListenerState()
      let previous: AgentHookEventPayload | undefined
      try {
        for (const [at, hookPayload] of [
          [1000, { hook_event_name: 'UserPromptSubmit', prompt: 'finish the task' }],
          [5000, { hook_event_name: 'Stop', last_assistant_message: 'Finished.' }]
        ] as const) {
          vi.setSystemTime(at)
          const event = normalizeHookPayload(
            listener,
            agent,
            {
              paneKey: PANE,
              tabId: 'tab-1',
              worktreeId: WORKSPACE,
              payload: { session_id: 'session-1', ...hookPayload }
            },
            'production'
          )
          if (!event) {
            throw new Error('Expected a normalized hook event')
          }
          const timing = reduceHostTurnEnd(previous, event, at, true)
          previous = { ...event, ...timing }
          const payload = { ...event.payload, ...timing, stateStartedAt: at }
          store
            .getState()
            .setAgentStatus(
              PANE,
              payload,
              undefined,
              { updatedAt: at, stateStartedAt: at },
              { worktreeId: WORKSPACE, tabId: 'tab-1', connectionId: null },
              { providerSession: { key: 'session_id', id: 'session-1' } }
            )
          observeAgentHookCompletionForNotification({
            paneKey: PANE,
            worktreeId: WORKSPACE,
            payload
          })
        }
        if (exitAfterDelivery) {
          await vi.advanceTimersByTimeAsync(2000)
        }
        // Main may publish resume identity after clearing the exited process's turn claims.
        store
          .getState()
          .recordAgentProviderSession(
            PANE,
            agent,
            { key: 'session_id', id: 'session-1' },
            { updatedAt: Date.now() },
            { worktreeId: WORKSPACE, tabId: 'tab-1', connectionId: null }
          )
        store.setState({
          ptyIdsByTabId: {},
          suppressedPtyExitIds: suppressedExit ? { 'pty-1': true } : {},
          terminalLayoutsByTabId: {
            'tab-1': { ...store.getState().terminalLayoutsByTabId['tab-1'], ptyIdsByLeafId: {} }
          }
        })
        store.getState().removeAgentStatus(PANE)
        syncAgentHookCompletionNotificationSettings()
        await vi.advanceTimersByTimeAsync(2000)
        expect(notifications).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'agent-task-complete',
            agentType: agent,
            workspaceExecutionHostId: 'local',
            paneKey: PANE,
            worktreeId: WORKSPACE
          })
        )
        expect(store.getState().worktreesByRepo.repo1[0].isUnread).toBe(true)
        expect(store.getState().agentStatusByPaneKey.get(PANE)).toBeUndefined()
      } finally {
        resetAgentHookCompletionNotificationCoordinators()
      }
    }
  )
})
