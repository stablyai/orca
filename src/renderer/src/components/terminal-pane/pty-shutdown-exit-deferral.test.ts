import { expect, it, vi } from 'vitest'
import {
  applyHostWorktreeTerminalSleepState,
  consumeCommittedPtyShutdownExit,
  deferPtyShutdownExit,
  isHostPtySleepPending,
  markCommittedPtyShutdowns,
  settleDeferredPtyShutdownExits
} from './pty-shutdown-exit-deferral'
import { toRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import {
  bufferPtyShutdownData,
  bufferPtyShutdownReplayData,
  isPtyDataHandlerShutdownPending,
  ptyDataHandlers,
  ptyReplayHandlers,
  ptyShutdownLifecycleHandlers
} from './pty-shutdown-data-suspension'

it('settles every deferred exit even when one cleanup throws', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const second = vi.fn()
  deferPtyShutdownExit('pty-callback-isolation', () => {
    throw new Error('disposed pane')
  })
  deferPtyShutdownExit('pty-callback-isolation', second)

  expect(() =>
    settleDeferredPtyShutdownExits(['pty-callback-isolation'], 'committed')
  ).not.toThrow()
  expect(second).toHaveBeenCalledWith('committed')
  expect(consoleError).toHaveBeenCalled()
  consoleError.mockRestore()
})

it('consumes a committed late-exit guard only once', () => {
  markCommittedPtyShutdowns(['pty-late-commit'])

  expect(consumeCommittedPtyShutdownExit('pty-late-commit')).toBe(true)
  expect(consumeCommittedPtyShutdownExit('pty-late-commit')).toBe(false)
})

it('clears a committed guard when its deferred exit is replayed', () => {
  const callback = vi.fn()
  deferPtyShutdownExit('pty-deferred-commit', callback)
  markCommittedPtyShutdowns(['pty-deferred-commit'])

  settleDeferredPtyShutdownExits(['pty-deferred-commit'], 'committed')

  expect(callback).toHaveBeenCalledWith('committed')
  expect(consumeCommittedPtyShutdownExit('pty-deferred-commit')).toBe(false)
})

it('preserves another client binding through host sleep until the host reports wake', () => {
  const callback = vi.fn()
  const remotePtyId = toRemoteRuntimePtyId('terminal-handle-observer', 'env-a')
  const started = {
    type: 'worktreeTerminalSleepState' as const,
    worktreeId: 'repo::C:\\worktree',
    generation: 7,
    phase: 'started' as const,
    ptyIds: ['pty-observer'],
    terminalHandles: ['terminal-handle-observer']
  }
  applyHostWorktreeTerminalSleepState('env-a', started)
  expect(isHostPtySleepPending(remotePtyId, 'env-a')).toBe(true)
  expect(isHostPtySleepPending(remotePtyId, 'env-b')).toBe(false)
  deferPtyShutdownExit(remotePtyId, callback)

  applyHostWorktreeTerminalSleepState('env-a', { ...started, phase: 'committed' })
  expect(callback).toHaveBeenCalledWith('committed')
  expect(consumeCommittedPtyShutdownExit(remotePtyId, 'env-a')).toBe(true)
  expect(consumeCommittedPtyShutdownExit(remotePtyId, 'env-b')).toBe(false)

  applyHostWorktreeTerminalSleepState('env-a', { ...started, phase: 'woken' })
  expect(consumeCommittedPtyShutdownExit(remotePtyId, 'env-a')).toBe(false)
})

it('accepts an ordered local host reversible-stop exit before pane cleanup', () => {
  markCommittedPtyShutdowns(['pty-host-renderer'])

  expect(consumeCommittedPtyShutdownExit('pty-host-renderer')).toBe(true)
})

it('suspends passive-client output until the host sleep disposition settles', () => {
  const remotePtyId = toRemoteRuntimePtyId('terminal-passive', 'env-passive')
  const dataHandler = vi.fn()
  const replayHandler = vi.fn()
  const lifecycle = { pause: vi.fn(), rollback: vi.fn(), commit: vi.fn() }
  ptyDataHandlers.set(remotePtyId, dataHandler)
  ptyReplayHandlers.set(remotePtyId, replayHandler)
  ptyShutdownLifecycleHandlers.set(remotePtyId, lifecycle)
  const event = {
    type: 'worktreeTerminalSleepState' as const,
    worktreeId: 'repo::worktree',
    generation: 31,
    phase: 'started' as const,
    ptyIds: ['pty-passive'],
    terminalHandles: ['terminal-passive']
  }

  applyHostWorktreeTerminalSleepState('env-passive', event)
  expect(lifecycle.pause).toHaveBeenCalledOnce()
  expect(isPtyDataHandlerShutdownPending(remotePtyId)).toBe(true)
  expect(bufferPtyShutdownData(remotePtyId, 'teardown flush')).toBe(true)
  expect(dataHandler).not.toHaveBeenCalled()

  applyHostWorktreeTerminalSleepState('env-passive', { ...event, phase: 'cancelled' })
  expect(lifecycle.rollback).toHaveBeenCalledOnce()
  expect(dataHandler).toHaveBeenCalledWith('teardown flush', undefined)
  ptyDataHandlers.delete(remotePtyId)
  ptyReplayHandlers.delete(remotePtyId)
  ptyShutdownLifecycleHandlers.delete(remotePtyId)
})

it('expires a committed host disposition when a disconnected client misses wake', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2026-07-21T00:00:00Z'))
    const remotePtyId = toRemoteRuntimePtyId('terminal-reused', 'env-expiry')
    const event = {
      type: 'worktreeTerminalSleepState' as const,
      worktreeId: 'repo::worktree',
      generation: 41,
      phase: 'committed' as const,
      ptyIds: ['pty-reused'],
      terminalHandles: ['terminal-reused']
    }
    applyHostWorktreeTerminalSleepState('env-expiry', event)
    expect(consumeCommittedPtyShutdownExit(remotePtyId, 'env-expiry')).toBe(true)

    applyHostWorktreeTerminalSleepState('env-expiry', event)
    vi.advanceTimersByTime(30_001)
    expect(consumeCommittedPtyShutdownExit(remotePtyId, 'env-expiry')).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

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

it('rearms pending expiry for a duplicate host started event', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2026-07-21T00:00:00Z'))
    const remotePtyId = toRemoteRuntimePtyId('terminal-duplicate', 'env-duplicate')
    const event = {
      type: 'worktreeTerminalSleepState' as const,
      worktreeId: 'repo::worktree',
      generation: 61,
      phase: 'started' as const,
      ptyIds: ['pty-duplicate'],
      terminalHandles: ['terminal-duplicate']
    }
    applyHostWorktreeTerminalSleepState('env-duplicate', event)
    vi.advanceTimersByTime(20_000)
    applyHostWorktreeTerminalSleepState('env-duplicate', event)

    vi.advanceTimersByTime(10_001)
    expect(isHostPtySleepPending(remotePtyId, 'env-duplicate')).toBe(true)
    vi.advanceTimersByTime(20_000)
    expect(isHostPtySleepPending(remotePtyId, 'env-duplicate')).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

it('ignores an older commit after a newer sleep generation starts', () => {
  const remotePtyId = toRemoteRuntimePtyId('terminal-generation', 'env-generation')
  const event = {
    type: 'worktreeTerminalSleepState' as const,
    worktreeId: 'repo::worktree',
    phase: 'started' as const,
    ptyIds: ['pty-generation'],
    terminalHandles: ['terminal-generation']
  }
  applyHostWorktreeTerminalSleepState('env-generation', { ...event, generation: 72 })

  applyHostWorktreeTerminalSleepState('env-generation', {
    ...event,
    generation: 71,
    phase: 'committed'
  })

  expect(isHostPtySleepPending(remotePtyId, 'env-generation')).toBe(true)
  expect(consumeCommittedPtyShutdownExit(remotePtyId, 'env-generation')).toBe(false)
  applyHostWorktreeTerminalSleepState('env-generation', {
    ...event,
    generation: 72,
    phase: 'cancelled'
  })
})

it('retains a cancelled generation barrier against an older commit', () => {
  const remotePtyId = toRemoteRuntimePtyId('terminal-cancelled-order', 'env-order')
  const event = {
    type: 'worktreeTerminalSleepState' as const,
    worktreeId: 'repo::worktree',
    ptyIds: ['pty-cancelled-order'],
    terminalHandles: ['terminal-cancelled-order']
  }
  applyHostWorktreeTerminalSleepState('env-order', {
    ...event,
    generation: 82,
    phase: 'started'
  })
  applyHostWorktreeTerminalSleepState('env-order', {
    ...event,
    generation: 82,
    phase: 'cancelled'
  })

  applyHostWorktreeTerminalSleepState('env-order', {
    ...event,
    generation: 81,
    phase: 'committed'
  })

  expect(consumeCommittedPtyShutdownExit(remotePtyId, 'env-order')).toBe(false)
})

it('retains a woken generation barrier against an older start', () => {
  const remotePtyId = toRemoteRuntimePtyId('terminal-woken-order', 'env-order')
  const event = {
    type: 'worktreeTerminalSleepState' as const,
    worktreeId: 'repo::worktree',
    ptyIds: ['pty-woken-order'],
    terminalHandles: ['terminal-woken-order']
  }
  applyHostWorktreeTerminalSleepState('env-order', {
    ...event,
    generation: 92,
    phase: 'committed'
  })
  applyHostWorktreeTerminalSleepState('env-order', {
    ...event,
    generation: 92,
    phase: 'woken'
  })

  applyHostWorktreeTerminalSleepState('env-order', {
    ...event,
    generation: 91,
    phase: 'started'
  })

  expect(isHostPtySleepPending(remotePtyId, 'env-order')).toBe(false)
  expect(consumeCommittedPtyShutdownExit(remotePtyId, 'env-order')).toBe(false)
})

it('does not regress a committed generation back to started', () => {
  const remotePtyId = toRemoteRuntimePtyId('terminal-committed-order', 'env-order')
  const event = {
    type: 'worktreeTerminalSleepState' as const,
    worktreeId: 'repo::worktree',
    generation: 102,
    ptyIds: ['pty-committed-order'],
    terminalHandles: ['terminal-committed-order']
  }
  applyHostWorktreeTerminalSleepState('env-order', { ...event, phase: 'committed' })

  applyHostWorktreeTerminalSleepState('env-order', { ...event, phase: 'started' })

  expect(isHostPtySleepPending(remotePtyId, 'env-order')).toBe(false)
  expect(consumeCommittedPtyShutdownExit(remotePtyId, 'env-order')).toBe(true)
  expect(consumeCommittedPtyShutdownExit(remotePtyId, 'env-order')).toBe(false)
})

it('commits a pending exit when wake proves the sleep completed', () => {
  const remotePtyId = toRemoteRuntimePtyId('terminal-missed-commit', 'env-missed-commit')
  const lifecycle = { pause: vi.fn(), rollback: vi.fn(), commit: vi.fn() }
  const exitHandler = vi.fn()
  ptyShutdownLifecycleHandlers.set(remotePtyId, lifecycle)
  const event = {
    type: 'worktreeTerminalSleepState' as const,
    worktreeId: 'repo::worktree',
    generation: 111,
    ptyIds: ['pty-missed-commit'],
    terminalHandles: ['terminal-missed-commit']
  }
  applyHostWorktreeTerminalSleepState('env-missed-commit', { ...event, phase: 'started' })
  deferPtyShutdownExit(remotePtyId, exitHandler)

  applyHostWorktreeTerminalSleepState('env-missed-commit', { ...event, phase: 'woken' })

  expect(lifecycle.commit).toHaveBeenCalledOnce()
  expect(lifecycle.rollback).not.toHaveBeenCalled()
  expect(exitHandler).toHaveBeenCalledWith('committed')
  expect(isHostPtySleepPending(remotePtyId, 'env-missed-commit')).toBe(false)
  ptyShutdownLifecycleHandlers.delete(remotePtyId)
})

it('retains every active host guard above the former count cap', () => {
  const ptyIds: string[] = []
  for (let index = 0; index < 513; index += 1) {
    const handle = `terminal-large-${index}`
    const remotePtyId = toRemoteRuntimePtyId(handle, 'env-large')
    ptyIds.push(remotePtyId)
    applyHostWorktreeTerminalSleepState('env-large', {
      type: 'worktreeTerminalSleepState',
      worktreeId: 'repo::large-worktree',
      generation: 121,
      phase: 'committed',
      ptyIds: [`pty-large-${index}`],
      terminalHandles: [handle]
    })
  }

  for (const ptyId of ptyIds) {
    expect(consumeCommittedPtyShutdownExit(ptyId, 'env-large')).toBe(true)
  }
})
