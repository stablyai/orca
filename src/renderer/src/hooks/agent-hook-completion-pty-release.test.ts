import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, makeTab, makeWorktree } from '../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { buildAgentNotificationId } from '../../../shared/agent-notification-id'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import type { AgentCompletionStatusSnapshot } from '../components/terminal-pane/agent-completion-coordinator-types'
import type { ConnectPanePtySession } from '../components/terminal-pane/pty-connection/connect-pane-pty-session'
import {
  createManager,
  createMockTransport,
  createPane,
  LEAF_1
} from '../components/terminal-pane/pty-connection-test-pane-fixtures'

let store: ReturnType<typeof createTestStore>

vi.mock('@/store', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const worktreeId = 'repo1::/path/wt1'
const paneKey = `tab-1:${LEAF_1}`

function status(
  state: AgentCompletionStatusSnapshot['state'],
  at: number,
  start: number,
  runId = 'run-1'
): AgentCompletionStatusSnapshot {
  return {
    state,
    prompt: 'finish the task',
    agentType: 'codex',
    runId,
    executionId: 'execution-1',
    connectionId: null,
    terminalHandle: 'terminal-1',
    authorityRestartId: 'restart-1',
    stateStartedAt: at,
    turnStartedAt: start,
    ...(state === 'done' ? { lastAssistantMessage: 'Done.' } : {})
  }
}

describe('delayed hook completion after retained local process failure', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    vi.stubGlobal('window', undefined)
    const api = createStoreSessionMockApi()
    vi.stubGlobal('window', {
      api: {
        ...api,
        notifications: {
          dispatch: vi.fn().mockResolvedValue({ delivered: true }),
          dismiss: vi.fn().mockResolvedValue({ dismissed: 0 })
        }
      }
    })
    vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false })
    store = createTestStore()
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/path/wt1', hostId: 'local' })
        ]
      },
      activeWorktreeId: null,
      settings: createGlobalSettingsFixture(),
      tabsByWorktree: { [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: 'pty-1' })] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_1 },
          activeLeafId: LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_1]: 'pty-1' }
        }
      }
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('requests main-admitted captured news once without recovering withdrawal debt', async () => {
    const {
      observeAgentHookCompletionForNotification: observe,
      syncAgentHookCompletionNotificationSettings: sync,
      _getAgentHookCompletionNotificationCoordinatorCountForTest: coordinatorCount
    } = await import('./agent-hook-completion-notifications')
    const { dispatchTerminalNotification } =
      await import('../components/terminal-pane/use-notification-dispatch')
    const { installPtyExitHibernate } =
      await import('../components/terminal-pane/pty-connection/pty-exit-hibernate')
    const at = Date.now()
    const done = status('done', at + 100, at)
    observe({ paneKey, worktreeId, payload: status('working', at, at) })
    observe({ paneKey, worktreeId, payload: status('waiting', at + 25, at) })
    expect(window.api.notifications.dispatch).toHaveBeenCalledOnce()
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationId: buildAgentNotificationId({ worktreeId, paneKey, stateStartedAt: at + 25 })
      })
    )
    observe({ paneKey, worktreeId, payload: status('working', at + 50, at) })
    expect(window.api.notifications.dismiss).not.toHaveBeenCalled()
    vi.mocked(window.api.notifications.dispatch).mockClear()
    observe({ paneKey, worktreeId, payload: done })
    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()

    const transport = createMockTransport('pty-1')
    const manager = createManager(1)
    const onPaneProcessDied = vi.fn()
    const ptyCoordinatorDispose = vi.fn()
    const session = {
      pane: createPane(1),
      manager,
      transport,
      runtimeEnvironmentId: null,
      paneStartup: null,
      cacheKey: paneKey,
      agentCompletionCoordinator: { dispose: ptyCoordinatorDispose },
      resetRendererOrderedSeqForPtyExit: vi.fn(),
      dropSideEffectFactConsumer: vi.fn(),
      releaseHiddenRendererPtyDelivery: vi.fn(),
      clearPanePtyFitBinding: vi.fn(),
      clearExitedPanePtyLayoutBinding: () => {
        store.getState().setTabLayout('tab-1', {
          root: { type: 'leaf', leafId: LEAF_1 },
          activeLeafId: LEAF_1,
          expandedLeafId: null
        })
      },
      deps: {
        tabId: 'tab-1',
        paneTransportsRef: { current: new Map([[1, transport]]) },
        isPtyShutdownPending: store.getState().isPtyShutdownPending,
        consumeSuppressedPtyExit: store.getState().consumeSuppressedPtyExit,
        clearTabPtyId: store.getState().clearTabPtyId,
        clearRuntimePaneTitle: store.getState().clearRuntimePaneTitle,
        setCacheTimerStartedAt: store.getState().setCacheTimerStartedAt,
        onPaneProcessDied,
        onPtyExitRef: { current: vi.fn() }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this exit-only bag supplies every invoked member; the store release and notification admission remain real.
    const exitSession = session as unknown as ConnectPanePtySession
    installPtyExitHibernate(exitSession)
    exitSession.transport.disconnect()
    exitSession.onExit('pty-1', 1)
    sync()
    expect(ptyCoordinatorDispose).toHaveBeenCalledOnce()
    expect(onPaneProcessDied).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 1, exitCode: 1, reason: 'process-failed' })
    )
    expect(session.deps.onPtyExitRef.current).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([])
    expect(store.getState().tabsByWorktree[worktreeId][0].ptyId).toBeNull()
    expect(store.getState().agentStatusByPaneKey[paneKey]).toBeUndefined()
    expect(coordinatorCount()).toBe(1)

    // Main's adapter forwards this captured snapshot to the same real admission path.
    expect(
      dispatchTerminalNotification(worktreeId, {
        source: 'agent-task-complete',
        terminalTitle: 'codex',
        paneKey,
        agentStatusSnapshot: done
      })
    ).toBe(true)
    const dispatch = vi.mocked(window.api.notifications.dispatch)
    expect(dispatch).toHaveBeenCalledOnce()
    const mainRequest = dispatch.mock.calls[0][0]
    const notificationId = buildAgentNotificationId({
      worktreeId,
      paneKey,
      stateStartedAt: at + 100
    })
    expect(mainRequest).toMatchObject({ notificationId, paneKey, agentState: 'done' })
    dispatch.mockClear()
    vi.advanceTimersByTime(1_500)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(mainRequest)
    expect(window.api.notifications.dismiss).not.toHaveBeenCalled()

    store.getState().updateTabPtyId('tab-1', 'pty-1')
    observe({ paneKey, worktreeId, payload: status('working', at + 2_000, at + 2_000) })
    expect(window.api.notifications.dismiss).not.toHaveBeenCalled()
    store.getState().clearTabPtyId('tab-1', 'pty-1')
    observe({ paneKey, worktreeId, payload: status('working', at + 2_000, at + 2_000, 'run-2') })
    observe({ paneKey, worktreeId, payload: status('done', at + 2_100, at + 2_000, 'run-2') })
    store.getState().updateTabPtyId('tab-1', 'pty-2')
    vi.advanceTimersByTime(1_500)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[1][0].notificationId).toBe(
      buildAgentNotificationId({ worktreeId, paneKey, stateStartedAt: at + 2_100 })
    )
    observe({ paneKey, worktreeId, payload: status('working', at + 4_000, at + 4_000, 'run-2') })
    expect(window.api.notifications.dismiss).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledTimes(2)
  })
})
