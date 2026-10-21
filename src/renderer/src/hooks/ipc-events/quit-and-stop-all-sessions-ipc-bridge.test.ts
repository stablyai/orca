// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

type KillAllSummary = {
  failedCloseAttemptCount: number
  exactKillRejectedCount: number
  daemon:
    | { status: 'fulfilled'; killedCount: number; remainingCount: number }
    | { status: 'rejected' }
}

const mocks = vi.hoisted(() => ({
  runKillAll: vi.fn<(ids: readonly string[]) => Promise<KillAllSummary>>(),
  snapshotIds: vi.fn(() => ['tab-1', 'tab-2']),
  waitReady: vi.fn<() => Promise<boolean>>(),
  storeState: { hydrationSucceeded: true },
  toastError: vi.fn()
}))

vi.mock('@/components/shared/kill-all-terminal-surfaces', () => ({
  runKillAllTerminalSurfaces: mocks.runKillAll,
  snapshotKillAllTerminalSurfaceIds: mocks.snapshotIds
}))
vi.mock('@/lib/worktree-agent-activation-gate', () => ({
  waitForWorkspaceSessionReady: mocks.waitReady
}))
vi.mock('../../store', () => ({ useAppStore: { getState: () => mocks.storeState } }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import { registerQuitAndStopAllSessionsIpcBridge } from './quit-and-stop-all-sessions-ipc-bridge'

const FAILURE_MESSAGE = "Couldn't stop every terminal session, so Orca stayed open."
const CLEAN_SUMMARY: KillAllSummary = {
  failedCloseAttemptCount: 0,
  exactKillRejectedCount: 0,
  daemon: { status: 'fulfilled', killedCount: 2, remainingCount: 0 }
}

let pushListener: (() => void) | null
let pending: boolean[]
const quitAfterStoppingAllSessions = vi.fn()

function installUiApi(): void {
  Object.assign(window, {
    api: {
      ui: {
        onQuitAndStopAllSessions: (callback: () => void) => {
          pushListener = callback
          return () => {}
        },
        consumePendingQuitAndStopAllSessions: async () => pending.shift() ?? false,
        quitAfterStoppingAllSessions
      }
    }
  })
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('registerQuitAndStopAllSessionsIpcBridge', () => {
  beforeEach(() => {
    pushListener = null
    pending = []
    quitAfterStoppingAllSessions.mockReset()
    mocks.runKillAll.mockReset().mockResolvedValue(CLEAN_SUMMARY)
    mocks.snapshotIds.mockClear()
    mocks.waitReady.mockReset().mockResolvedValue(true)
    mocks.storeState.hydrationSucceeded = true
    mocks.toastError.mockReset()
    installUiApi()
  })

  it('stops every terminal surface, then asks main to quit', async () => {
    registerQuitAndStopAllSessionsIpcBridge([])
    await settle()

    pending.push(true)
    pushListener?.()
    await settle()

    expect(mocks.runKillAll).toHaveBeenCalledWith(['tab-1', 'tab-2'])
    expect(quitAfterStoppingAllSessions).toHaveBeenCalledOnce()
    expect(mocks.runKillAll.mock.invocationCallOrder[0]).toBeLessThan(
      quitAfterStoppingAllSessions.mock.invocationCallOrder[0]
    )
  })

  it('acts on a request queued before the listener attached', async () => {
    pending.push(true)

    registerQuitAndStopAllSessionsIpcBridge([])
    await settle()

    expect(quitAfterStoppingAllSessions).toHaveBeenCalledOnce()
  })

  it('does nothing for a push whose request was already consumed', async () => {
    registerQuitAndStopAllSessionsIpcBridge([])
    pushListener?.()
    await settle()

    expect(mocks.runKillAll).not.toHaveBeenCalled()
    expect(quitAfterStoppingAllSessions).not.toHaveBeenCalled()
  })

  it.each([
    ['the restored tabs never became ready', () => mocks.waitReady.mockResolvedValue(false)],
    [
      'the session restore failed, so closed tabs would not be saved',
      () => {
        mocks.storeState.hydrationSucceeded = false
      }
    ]
  ])('stops nothing and stays open when %s', async (_name, arrange) => {
    arrange()
    pending.push(true)

    registerQuitAndStopAllSessionsIpcBridge([])
    await settle()

    expect(mocks.runKillAll).not.toHaveBeenCalled()
    expect(quitAfterStoppingAllSessions).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(FAILURE_MESSAGE)
  })

  it.each([
    ['the daemon sweep failed', { ...CLEAN_SUMMARY, daemon: { status: 'rejected' as const } }],
    [
      'a session refused to exit',
      {
        ...CLEAN_SUMMARY,
        daemon: { status: 'fulfilled' as const, killedCount: 1, remainingCount: 1 }
      }
    ],
    ['a tab failed to close', { ...CLEAN_SUMMARY, failedCloseAttemptCount: 1 }],
    ['a PTY shutdown was rejected', { ...CLEAN_SUMMARY, exactKillRejectedCount: 1 }]
  ])('stays open and says so when %s', async (_name, summary) => {
    mocks.runKillAll.mockResolvedValue(summary)
    pending.push(true)

    registerQuitAndStopAllSessionsIpcBridge([])
    await settle()

    expect(quitAfterStoppingAllSessions).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(FAILURE_MESSAGE)
  })
})
