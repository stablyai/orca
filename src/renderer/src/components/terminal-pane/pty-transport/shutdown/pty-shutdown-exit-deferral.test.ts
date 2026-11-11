import { expect, it, vi } from 'vitest'
import {
  applyHostWorktreeTerminalSleepState,
  deferPtyShutdownExit
} from './pty-shutdown-exit-deferral'
import { toRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  bufferPtyShutdownData,
  bufferPtyShutdownReplayData,
  isPtyDataHandlerShutdownPending,
  ptyDataHandlers,
  ptyReplayHandlers,
  ptyShutdownLifecycleHandlers
} from './pty-shutdown-data-suspension'

it('autonomously rolls back a pending host sleep when its outcome is missed', () => {
  vi.useFakeTimers()
  const remotePtyId = toRemoteRuntimePtyId('terminal-timeout', 'env-timeout')
  const dataHandler = vi.fn()
  const replayHandler = vi.fn()
  const lifecycle = { pause: vi.fn(), rollback: vi.fn(), commit: vi.fn() }
  const exitHandler = vi.fn()
  try {
    vi.setSystemTime(new Date('2026-07-21T00:00:00Z'))
    ptyDataHandlers.set(remotePtyId, dataHandler)
    ptyReplayHandlers.set(remotePtyId, replayHandler)
    ptyShutdownLifecycleHandlers.set(remotePtyId, lifecycle)
    deferPtyShutdownExit(remotePtyId, exitHandler)

    applyHostWorktreeTerminalSleepState('env-timeout', {
      type: 'worktreeTerminalSleepState',
      worktreeId: 'repo::worktree',
      generation: 51,
      phase: 'started',
      ptyIds: ['pty-timeout'],
      terminalHandles: ['terminal-timeout']
    })
    expect(bufferPtyShutdownData(remotePtyId, 'live output')).toBe(true)
    expect(bufferPtyShutdownReplayData(remotePtyId, 'replay output')).toBe(true)

    vi.advanceTimersByTime(30_001)

    expect(lifecycle.rollback).toHaveBeenCalledOnce()
    expect(isPtyDataHandlerShutdownPending(remotePtyId)).toBe(false)
    expect(dataHandler).toHaveBeenCalledWith('live output', undefined)
    expect(replayHandler).toHaveBeenCalledWith('replay output')
    expect(exitHandler).toHaveBeenCalledWith('rolled-back')
  } finally {
    ptyDataHandlers.delete(remotePtyId)
    ptyReplayHandlers.delete(remotePtyId)
    ptyShutdownLifecycleHandlers.delete(remotePtyId)
    vi.useRealTimers()
  }
})
