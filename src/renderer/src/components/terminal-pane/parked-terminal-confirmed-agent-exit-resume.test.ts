import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParkedTerminalByteWatcherOptions } from './parked-terminal-byte-watcher'
import type * as ParkedTerminalCommandStatus from './parked-terminal-command-status'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'

const PTY_ID = 'pty-parked-exit'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'repo-1::/tmp/wt-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`

type MockStoreState = {
  settings: { terminalMainSideEffectAuthority?: boolean } | null
  setRuntimePaneTitle: ReturnType<typeof vi.fn>
  clearRuntimePaneTitle: ReturnType<typeof vi.fn>
  updateTabTitle: ReturnType<typeof vi.fn>
  markWorktreeUnread: ReturnType<typeof vi.fn>
  markTerminalTabUnread: ReturnType<typeof vi.fn>
  markTerminalPaneUnread: ReturnType<typeof vi.fn>
  setCacheTimerStartedAt: ReturnType<typeof vi.fn>
  observeTerminalGitHubPullRequestLink: ReturnType<typeof vi.fn>
  agentStatusByPaneKey: Record<string, never>
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>
  clearSleepingAgentSession: ReturnType<typeof vi.fn>
  clearSleepingAgentSessionsByPaneKey: ReturnType<typeof vi.fn>
}

let mockStoreState: MockStoreState

vi.mock('./use-notification-dispatch', () => ({
  dispatchTerminalNotification: vi.fn()
}))

vi.mock('./parked-terminal-command-status', async (importOriginal) => ({
  ...(await importOriginal<typeof ParkedTerminalCommandStatus>()),
  createParkedTerminalCommandStatusPolicy: vi.fn(() => ({
    onCommandFinished: vi.fn(),
    onCommandCodeWorking: vi.fn(),
    onCommandCodeDone: vi.fn(),
    dispose: vi.fn()
  }))
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState
  }
}))

describe('parked terminal confirmed agent-exit resume retirement', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    vi.resetModules()
    mockStoreState = {
      settings: { terminalMainSideEffectAuthority: true },
      setRuntimePaneTitle: vi.fn(),
      clearRuntimePaneTitle: vi.fn(),
      updateTabTitle: vi.fn(),
      markWorktreeUnread: vi.fn(),
      markTerminalTabUnread: vi.fn(),
      markTerminalPaneUnread: vi.fn(),
      setCacheTimerStartedAt: vi.fn(),
      observeTerminalGitHubPullRequestLink: vi.fn(),
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {},
      clearSleepingAgentSession: vi.fn((paneKey: string) => {
        delete mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]
      }),
      clearSleepingAgentSessionsByPaneKey: vi.fn((paneKeys: readonly string[]) => {
        for (const paneKey of paneKeys) {
          delete mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]
        }
      })
    }
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        pty: {
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {}),
          ackData: vi.fn()
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    }
  })

  it('retires only a host-confirmed parked-pane agent exit', async () => {
    const { startParkedTerminalByteWatcher } = await import('./parked-terminal-byte-watcher')
    const handler = await import('./terminal-side-effect-facts-handler')
    mockStoreState.sleepingAgentSessionsByPaneKey = {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'parked-session' },
        prompt: 'finish the task',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'live'
      }
    }

    const dispose = startParkedTerminalByteWatcher({
      ptyId: PTY_ID,
      incarnationId: 'inc-parked-exit',
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      paneId: 1
    } satisfies ParkedTerminalByteWatcherOptions)
    handler._dispatchTerminalSideEffectBatchForTest({
      ptyId: PTY_ID,
      seq: 1,
      facts: [{ kind: 'agent-exited' }]
    })

    expect(mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeDefined()

    handler._dispatchTerminalSideEffectBatchForTest({
      ptyId: PTY_ID,
      seq: 2,
      paneKey: PANE_KEY,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      facts: [
        {
          kind: 'agent-exited',
          executionHostConfirmed: true,
          incarnationId: 'inc-parked-exit'
        }
      ]
    })

    expect(mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
    dispose()
  })

  it('retires a legacy numeric-key resume record for the parked pane', async () => {
    const { startParkedTerminalByteWatcher } = await import('./parked-terminal-byte-watcher')
    const handler = await import('./terminal-side-effect-facts-handler')
    const legacyPaneKey = `${TAB_ID}:1`
    mockStoreState.sleepingAgentSessionsByPaneKey = {
      [legacyPaneKey]: {
        paneKey: legacyPaneKey,
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'parked-session' },
        prompt: 'finish the task',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'live'
      }
    }

    const dispose = startParkedTerminalByteWatcher({
      ptyId: PTY_ID,
      incarnationId: 'inc-parked-exit',
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      paneId: 1
    } satisfies ParkedTerminalByteWatcherOptions)
    handler._dispatchTerminalSideEffectBatchForTest({
      ptyId: PTY_ID,
      seq: 1,
      paneKey: PANE_KEY,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      facts: [
        {
          kind: 'agent-exited',
          executionHostConfirmed: true,
          incarnationId: 'inc-parked-exit'
        }
      ]
    })

    expect(mockStoreState.sleepingAgentSessionsByPaneKey[legacyPaneKey]).toBeUndefined()
    dispose()
  })
})
