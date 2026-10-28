// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KillAllTerminalSurfacesSummary } from '@/components/shared/kill-all-terminal-surfaces'

type KillAllSummary = Pick<
  KillAllTerminalSurfacesSummary,
  'failedCloseAttemptCount' | 'exactKillRejectedCount' | 'daemon'
>

const mocks = vi.hoisted(() => ({
  runKillAll: vi.fn<(ids: readonly string[]) => Promise<KillAllSummary>>(),
  snapshotIds: vi.fn<() => string[]>(),
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
vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, loading: vi.fn(() => 'progress'), dismiss: vi.fn() }
}))

import { registerQuitAndStopAllSessionsIpcBridge } from './quit-and-stop-all-sessions-ipc-bridge'

const FAILURE_MESSAGE = "Couldn't stop every terminal session, so Orca stayed open."
const CLEAN_SUMMARY: KillAllSummary = {
  failedCloseAttemptCount: 0,
  exactKillRejectedCount: 0,
  daemon: { status: 'fulfilled', killedCount: 2, remainingCount: 0 }
}

let pushListener: (() => void) | null
let unhandledRejections: unknown[] = []
const recordUnhandledRejection = (reason: unknown): void => void unhandledRejections.push(reason)
let pending: boolean[]
const quitAfterStoppingAllSessions = vi.fn<() => Promise<boolean>>()

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

function expectStayedOpen(): void {
  expect(quitAfterStoppingAllSessions).not.toHaveBeenCalled()
  expect(mocks.toastError).toHaveBeenCalledWith(FAILURE_MESSAGE)
}

describe('registerQuitAndStopAllSessionsIpcBridge', () => {
  beforeEach(() => {
    pushListener = null
    pending = []
    quitAfterStoppingAllSessions.mockReset().mockResolvedValue(true)
    mocks.runKillAll.mockReset().mockResolvedValue(CLEAN_SUMMARY)
    // Kill all closes every tab it snapshotted, so a second snapshot is empty.
    mocks.snapshotIds.mockReset().mockReturnValueOnce(['tab-1', 'tab-2']).mockReturnValue([])
    mocks.waitReady.mockReset().mockResolvedValue(true)
    mocks.storeState.hydrationSucceeded = true
    mocks.toastError.mockReset()
    installUiApi()
    unhandledRejections = []
    process.on('unhandledRejection', recordUnhandledRejection)
  })

  afterEach(() => {
    process.off('unhandledRejection', recordUnhandledRejection)
    vi.restoreAllMocks()
  })

  it('waits for the restored session, stops every terminal surface, then asks main to quit', async () => {
    registerQuitAndStopAllSessionsIpcBridge([])
    await settle()

    pending.push(true)
    pushListener?.()
    await settle()

    expect(mocks.runKillAll).toHaveBeenCalledWith(['tab-1', 'tab-2'])
    expect(quitAfterStoppingAllSessions).toHaveBeenCalledOnce()
    const [waited, snapshotted, killed, quit] = [
      mocks.waitReady,
      mocks.snapshotIds,
      mocks.runKillAll,
      quitAfterStoppingAllSessions
    ].map((mock) => mock.mock.invocationCallOrder[0])
    expect(waited).toBeLessThan(snapshotted)
    expect(snapshotted).toBeLessThan(killed)
    expect(killed).toBeLessThan(quit)
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

  it('runs Kill all once while an earlier request is still stopping sessions', async () => {
    const killAll = Promise.withResolvers<KillAllSummary>()
    mocks.runKillAll.mockReturnValue(killAll.promise)
    pending.push(true, true)

    registerQuitAndStopAllSessionsIpcBridge([])
    await settle()
    pushListener?.()
    await settle()
    killAll.resolve(CLEAN_SUMMARY)
    await settle()

    expect(mocks.runKillAll).toHaveBeenCalledOnce()
    expect(quitAfterStoppingAllSessions).toHaveBeenCalledOnce()
  })

  it.each([
    [
      'the restored tabs never became ready',
      () => mocks.waitReady.mockResolvedValue(false),
      { ready: false, hydrationSucceeded: true }
    ],
    [
      'the session restore failed, so closed tabs would not be saved',
      () => {
        mocks.storeState.hydrationSucceeded = false
      },
      { ready: true, hydrationSucceeded: false }
    ]
  ])('stops nothing and stays open when %s', async (_name, arrange, logged) => {
    arrange()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pending.push(true)

    registerQuitAndStopAllSessionsIpcBridge([])
    await settle()

    expect(mocks.runKillAll).not.toHaveBeenCalled()
    expectStayedOpen()
    expect(warn).toHaveBeenCalledWith(
      '[quit-and-stop-all-sessions] Workspace session not ready:',
      logged
    )
  })

  it.each<[string, KillAllSummary]>([
    ['the daemon sweep failed', { ...CLEAN_SUMMARY, daemon: { status: 'rejected' } }],
    [
      'a session refused to exit',
      { ...CLEAN_SUMMARY, daemon: { status: 'fulfilled', killedCount: 1, remainingCount: 1 } }
    ],
    [
      'a daemon generation could not list its sessions',
      {
        ...CLEAN_SUMMARY,
        daemon: { status: 'fulfilled', killedCount: 0, remainingCount: 0, listingIncomplete: true }
      }
    ],
    ['a tab failed to close', { ...CLEAN_SUMMARY, failedCloseAttemptCount: 1 }],
    ['a PTY shutdown was rejected', { ...CLEAN_SUMMARY, exactKillRejectedCount: 1 }]
  ])('stays open and says so when %s', async (_name, summary) => {
    mocks.runKillAll.mockResolvedValue(summary)
    pending.push(true)

    registerQuitAndStopAllSessionsIpcBridge([])
    await settle()

    expectStayedOpen()
  })

  it('stays open when a terminal tab opened while Kill all ran', async () => {
    mocks.snapshotIds.mockReset().mockReturnValueOnce(['tab-1']).mockReturnValue(['tab-new'])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pending.push(true)

    registerQuitAndStopAllSessionsIpcBridge([])
    await settle()

    expectStayedOpen()
    expect(warn).toHaveBeenCalledWith(
      '[quit-and-stop-all-sessions] Terminal tabs opened during Kill all:',
      ['tab-new']
    )
  })

  it('stays open when main still lists a terminal session after Kill all', async () => {
    quitAfterStoppingAllSessions.mockResolvedValue(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pending.push(true)

    registerQuitAndStopAllSessionsIpcBridge([])
    await settle()

    expect(quitAfterStoppingAllSessions).toHaveBeenCalledOnce()
    expect(mocks.toastError).toHaveBeenCalledWith(FAILURE_MESSAGE)
    expect(warn).toHaveBeenCalledWith(
      '[quit-and-stop-all-sessions] Main still lists a terminal session after Kill all'
    )
  })

  it('stays open and says so when stopping the sessions throws', async () => {
    mocks.runKillAll.mockRejectedValue(new Error('IPC failed'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    pending.push(true)

    registerQuitAndStopAllSessionsIpcBridge([])
    await settle()

    expectStayedOpen()
    expect(error).toHaveBeenCalledWith(
      '[quit-and-stop-all-sessions] Stopping sessions failed:',
      expect.any(Error)
    )
  })

  it('stops nothing, without an unhandled rejection, when consuming the request fails', async () => {
    Object.assign(window.api.ui, {
      consumePendingQuitAndStopAllSessions: () => Promise.reject(new Error('IPC unavailable'))
    })

    registerQuitAndStopAllSessionsIpcBridge([])
    await settle()

    expect(mocks.waitReady).not.toHaveBeenCalled()
    expect(quitAfterStoppingAllSessions).not.toHaveBeenCalled()
    expect(unhandledRejections).toEqual([])
  })

  it('runs again on the next request after a failed attempt', async () => {
    mocks.runKillAll
      .mockResolvedValueOnce({ ...CLEAN_SUMMARY, failedCloseAttemptCount: 1 })
      .mockResolvedValue(CLEAN_SUMMARY)
    // The failed sweep returns before its re-check; the second sweep leaves no tab behind.
    mocks.snapshotIds
      .mockReset()
      .mockReturnValueOnce(['tab-1'])
      .mockReturnValueOnce(['tab-1'])
      .mockReturnValue([])
    pending.push(true)

    registerQuitAndStopAllSessionsIpcBridge([])
    await settle()
    expectStayedOpen()

    pending.push(true)
    pushListener?.()
    await settle()

    expect(mocks.runKillAll).toHaveBeenCalledTimes(2)
    expect(quitAfterStoppingAllSessions).toHaveBeenCalledOnce()
  })
})
