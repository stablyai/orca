import './pty-connection-mocks.spec'
import { describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import {
  announceMainDrop,
  connectVisiblePane,
  installHiddenRestoreFloodSuiteHooks,
  modelSnapshot,
  PTY_ID,
  type MainSnapshot
} from './pty-connection-test-hidden-restore-flood'

// Retired restore tasks cannot paint or consume the unhide recovery owed by their successor.

describe('hidden-output restore unhide with a retired task (STA-4869)', () => {
  installHiddenRestoreFloodSuiteHooks()

  it('ignores a timed-out task without consuming the next restore request', async () => {
    const drive = await connectVisiblePane()
    vi.useFakeTimers()
    const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    const first = createDeferred<MainSnapshot>()
    const second = createDeferred<MainSnapshot>()
    getMainBufferSnapshot.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    try {
      await announceMainDrop(64, 1)
      await announceMainDrop(64, 1, 'unhide')
      const waitingLive = 'LIVE_HELD_FOR_TIMEOUT\r\n'
      drive.deliver(waitingLive, 64 + waitingLive.length)
      await vi.advanceTimersByTimeAsync(800)
      await flushAsyncTicks(30)
      expect(drive.writtenChunks().join('')).toContain(waitingLive)

      await announceMainDrop(256, 2)
      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(30)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
      first.resolve(modelSnapshot('STALE_TIMED_OUT_CAPTURE', 128))
      await flushAsyncTicks(30)
      second.resolve(modelSnapshot('RECOVERED_AFTER_TIMEOUT', 512))
      await flushAsyncTicks(30)
      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(30)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
      expect(drive.writtenChunks().join('')).not.toContain('STALE_TIMED_OUT_CAPTURE')
      expect(drive.writtenChunks().join('')).toContain('RECOVERED_AFTER_TIMEOUT')
      expect(window.api.pty.ackHiddenOutputRestoreApplied).toHaveBeenCalledWith(PTY_ID, 2)
    } finally {
      drive.disposable.dispose()
    }
  })

  it('recovers a successor unhide with one quiet repaint, not a retired-task requirement too', async () => {
    const drive = await connectVisiblePane()
    vi.useFakeTimers()
    const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    const oldPtySnapshot = createDeferred<MainSnapshot>()
    const newPtySnapshot = createDeferred<MainSnapshot>()
    getMainBufferSnapshot
      .mockReturnValueOnce(oldPtySnapshot.promise)
      .mockReturnValueOnce(newPtySnapshot.promise)
      .mockResolvedValue(modelSnapshot('SECOND_SUCCESSOR_REPLAY', 1024))
    try {
      await announceMainDrop(64, 1)
      await announceMainDrop(64, 1, 'unhide')
      drive.transport.getPtyId.mockReturnValue('successor-pty')
      drive.setVisible(false)
      drive.deliver('NEW_PTY_OUTPUT\r\n', 32)
      drive.setVisible(true)
      await announceMainDrop(32, 2, 'hidden-drop', 'successor-pty')
      await announceMainDrop(512, 2, 'unhide', 'successor-pty')

      oldPtySnapshot.resolve(modelSnapshot('RETIRED_PTY_CAPTURE', 2048))
      await flushAsyncTicks(30)
      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(30)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
      // Seq below the marker: only a recorded unhide requirement would force a second replay.
      newPtySnapshot.resolve(modelSnapshot('SUCCESSOR_QUIET_REPAINT', 128))
      await flushAsyncTicks(30)
      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(30)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
      const written = drive.writtenChunks().join('')
      expect(written).not.toContain('RETIRED_PTY_CAPTURE')
      expect(written).toContain('SUCCESSOR_QUIET_REPAINT')
      expect(written).not.toContain('SECOND_SUCCESSOR_REPLAY')
      expect(window.api.pty.ackHiddenOutputRestoreApplied).not.toHaveBeenCalledWith(PTY_ID, 1)
      expect(window.api.pty.ackHiddenOutputRestoreApplied).toHaveBeenCalledWith('successor-pty', 2)
    } finally {
      drive.disposable.dispose()
    }
  })

  it('recovers an unhide-only successor while a retired PTY snapshot is pending', async () => {
    const drive = await connectVisiblePane()
    vi.useFakeTimers()
    const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    const oldPtySnapshot = createDeferred<MainSnapshot>()
    getMainBufferSnapshot
      .mockReturnValueOnce(oldPtySnapshot.promise)
      .mockResolvedValue(modelSnapshot('SUCCESSOR_UNHIDE_RECOVERED', 1024))
    try {
      await announceMainDrop(64, 1)
      drive.transport.getPtyId.mockReturnValue('successor-pty')
      drive.setVisible(false)
      drive.deliver('NEW_PTY_OUTPUT\r\n', 32)
      drive.setVisible(true)
      await announceMainDrop(512, 2, 'unhide', 'successor-pty')

      oldPtySnapshot.resolve(modelSnapshot('RETIRED_PTY_CAPTURE', 2048))
      await flushAsyncTicks(30)
      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(30)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
      expect(drive.writtenChunks().join('')).not.toContain('RETIRED_PTY_CAPTURE')
      expect(drive.writtenChunks().join('')).toContain('SUCCESSOR_UNHIDE_RECOVERED')
      expect(window.api.pty.ackHiddenOutputRestoreApplied).not.toHaveBeenCalledWith(PTY_ID, 1)
      expect(window.api.pty.ackHiddenOutputRestoreApplied).toHaveBeenCalledWith('successor-pty', 2)
    } finally {
      drive.disposable.dispose()
    }
  })

  it('cannot replay or acknowledge an unhide after its pane is disposed', async () => {
    const drive = await connectVisiblePane()
    vi.useFakeTimers()
    const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    const first = createDeferred<MainSnapshot>()
    getMainBufferSnapshot.mockReturnValueOnce(first.promise)
    await announceMainDrop(64, 1)
    await announceMainDrop(64, 1, 'unhide')
    drive.disposable.dispose()
    const writesBeforeDisposal = drive.writtenChunks().slice()
    first.resolve(modelSnapshot('DISPOSED_PANE_CAPTURE', 128))
    await flushAsyncTicks(30)
    await vi.advanceTimersByTimeAsync(2_100)
    await flushAsyncTicks(30)
    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
    expect(drive.writtenChunks()).toEqual(writesBeforeDisposal)
    expect(window.api.pty.ackHiddenOutputRestoreApplied).not.toHaveBeenCalled()
  })
})
