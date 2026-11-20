import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentStatusSetData } from './ipc-events-agent-status-store-test-fixtures'
import { buildWindowApi } from './ipc-events-agent-status-window-test-fixtures'
import { makeTab } from '../../../store/terminals/testing/terminal-tab.test-fixture'
import { makeUnifiedTab } from '../../../store/slices/tabs/tab-group.test-fixture'
import { makeWorktree } from '../../../store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '../../../store/repos/repo.test-fixture'
import { setPresenceGated } from '../../../attention/agent-auto-ack-presence'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { registerAgentStatusIpcBridge } from './agent-status-ipc-bridge'
import { dispatchTerminalNotification } from '../../../components/terminal-pane/notifications/dispatch-terminal-notification'
import { useAppStore } from '../../../store'

vi.mock('../../../store', async () => {
  const { createTestStore } = await import('../../../store/testing/app-store-test-fixture')
  return { useAppStore: createTestStore() }
})
// The lanes are replaced by direct restatements below; only admission is under test.
vi.mock(
  '../../../components/terminal-pane/agent-completion/hook-lane/agent-hook-completion-notifications',
  () => ({
    observeAgentHookCompletionForNotification: vi.fn(),
    syncAgentHookCompletionNotificationsForStoreUpdate: () => {}
  })
)
vi.mock('../../../store/github/refresh/stale-worktree-refresh-actions', () => ({
  createStaleWorktreeRefreshActions: () => ({ refreshGitHubForWorktreeIfStale: vi.fn() })
}))
vi.mock('@/lib/notifications/desktop-notification-sound', () => ({
  playDesktopNotificationSound: vi.fn()
}))
vi.mock('@/store/slices/worktrees/metadata/worktree-meta-persist', () => ({
  persistWorktreeMeta: vi.fn(async () => undefined)
}))

const NOW = 1_800_000_000_000
const WORKSPACE = 'repo1::/tmp/sleep'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-1:${LEAF}`
const notifications = vi.fn(async () => ({ delivered: true }))

function bindPty(ptyId: string): void {
  const layout = useAppStore.getState().terminalLayoutsByTabId['tab-1']
  useAppStore.setState({
    tabsByWorktree: { [WORKSPACE]: [makeTab({ id: 'tab-1', worktreeId: WORKSPACE, ptyId })] },
    ptyIdsByTabId: { 'tab-1': [ptyId] },
    terminalLayoutsByTabId: { 'tab-1': { ...layout, ptyIdsByLeafId: { [LEAF]: ptyId } } }
  })
}

let send: (event: AgentStatusSetData) => void
let disposeBridge: () => void

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  setPresenceGated(false)
  notifications.mockClear()
  vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false })
  const windowApi = buildWindowApi({
    onSet: (listener) => {
      send = listener
      return () => {}
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture builds `api` as a plain record.
  ;(windowApi.api as Record<string, unknown>).notifications = { dispatch: notifications }
  vi.stubGlobal('window', windowApi)
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    workspaceSessionReady: true,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only notification policy fields are read.
    settings: { experimentalTerminalAttention: true } as GlobalSettings,
    repos: [{ ...TEST_REPO, executionHostId: 'local' }],
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKSPACE, repoId: 'repo1', hostId: 'local' })]
    },
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
      'tab-1': { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
    },
    activeWorktreeId: null
  })
  bindPty('pty-1')
  const unsubs: (() => void)[] = []
  const bridge = registerAgentStatusIpcBridge(unsubs)
  disposeBridge = () => {
    bridge.disposeAsyncState()
    bridge.unsubscribeStore()
    for (const stop of unsubs) {
      stop()
    }
  }
})

afterEach(() => {
  disposeBridge()
  setPresenceGated(true)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('waking a pane slept mid-turn', () => {
  it('announces no finish until the pane runs a new turn', async () => {
    const agentType = 'codex'
    const working = {
      paneKey: PANE,
      connectionId: null,
      tabId: 'tab-1',
      worktreeId: WORKSPACE,
      state: 'working',
      prompt: 'Run delayed shell command',
      agentType,
      receivedAt: NOW,
      stateStartedAt: NOW
    } satisfies AgentStatusIpcPayload
    send(working)
    const slept = {
      ...working,
      state: 'done' as const,
      interrupted: true,
      stateStartedAt: NOW + 5
    }
    send({ ...slept, paneSleep: { ptyId: 'pty-1' }, isReplay: true })
    vi.advanceTimersByTime(40)
    vi.setSystemTime(NOW + 30_000)
    bindPty('pty-2')
    // Main hands the slept turn back to the resumed process.
    const resumed = {
      ...slept,
      isReplay: true,
      observation: {
        origin: 'launch',
        authorityId: 'main',
        incarnation: 2,
        revision: 3,
        observedAt: NOW + 30_000,
        kind: 'snapshot'
      }
    } satisfies AgentStatusIpcPayload
    send(resumed)
    vi.advanceTimersByTime(40)

    // The title lane reads the resumed agent's startup spinner; the hook lane re-sees the verdict.
    dispatchTerminalNotification(WORKSPACE, {
      source: 'agent-task-complete',
      terminalTitle: 'Run delayed shell command',
      paneKey: PANE
    })
    dispatchTerminalNotification(WORKSPACE, {
      source: 'agent-task-complete',
      terminalTitle: agentType,
      paneKey: PANE,
      agentStatusSnapshot: {
        state: 'done',
        prompt: slept.prompt ?? '',
        agentType,
        interrupted: true,
        stateStartedAt: slept.stateStartedAt
      }
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(notifications).not.toHaveBeenCalled()
    expect(useAppStore.getState().worktreesByRepo.repo1[0].isUnread).toBe(false)

    const turnAt = Date.now()
    send({ ...working, receivedAt: turnAt, stateStartedAt: turnAt })
    send({ ...working, state: 'done', receivedAt: turnAt + 10, stateStartedAt: turnAt + 10 })
    vi.advanceTimersByTime(40)
    dispatchTerminalNotification(WORKSPACE, {
      source: 'agent-task-complete',
      terminalTitle: 'Run delayed shell command',
      paneKey: PANE
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(notifications).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete', paneKey: PANE, agentType })
    )
    expect(useAppStore.getState().worktreesByRepo.repo1[0].isUnread).toBe(true)
  })
})
