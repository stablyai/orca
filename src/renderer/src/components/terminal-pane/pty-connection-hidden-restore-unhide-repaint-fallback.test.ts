import './pty-connection-mocks.spec'
import { describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import {
  announceMainDrop,
  BANNER_FRAGMENT,
  connectVisiblePane,
  installHiddenRestoreFloodSuiteHooks,
  modelSnapshot,
  OVERFLOW_CHUNK,
  PTY_ID,
  type MainSnapshot
} from './pty-connection-test-hidden-restore-flood'

// Unhide markers the in-flight snapshot cannot retire fall back to the deferred quiet repaint
// or a retry, and must still recover without a loss banner.

describe('hidden-output restore unhide repaint fallback (STA-4869)', () => {
  installHiddenRestoreFloodSuiteHooks()

  it('does not leave a parked repaint after a repeated episode is repaired', async () => {
    const { markTerminalFollowOutput, markTerminalPinnedViewport } =
      await import('@/lib/pane-manager/terminal-scroll-intent')
    const drive = await connectVisiblePane()
    vi.useFakeTimers()
    const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    const first = createDeferred<MainSnapshot>()
    getMainBufferSnapshot.mockReturnValueOnce(first.promise)
    getMainBufferSnapshot.mockResolvedValue(modelSnapshot('PARKED_EPISODE_RECOVERED', 512))
    try {
      await announceMainDrop(64, 1)
      drive.pane.terminal.buffer.active.baseY = 100
      drive.pane.terminal.buffer.active.viewportY = 42
      markTerminalPinnedViewport(drive.pane.terminal)
      await announceMainDrop(256, 2, 'unhide')
      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(20)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
      await announceMainDrop(256, 2, 'unhide')
      first.resolve(modelSnapshot('PRE_EPISODE_CAPTURE', 128))
      await flushAsyncTicks(50)
      const repairAlreadyPainted = getMainBufferSnapshot.mock.calls.length === 2
      if (repairAlreadyPainted) {
        const live = 'LIVE_AFTER_PARKED_REPAIR\r\n'
        drive.deliver(live, 512 + live.length)
        await flushAsyncTicks(10)
      }
      const writesBeforeFollowing = drive.writtenChunks().length
      drive.pane.terminal.buffer.active.viewportY = drive.pane.terminal.buffer.active.baseY
      markTerminalFollowOutput(drive.pane.terminal)
      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(50)
      expect.soft(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
      if (repairAlreadyPainted) {
        expect(drive.writtenChunks().slice(writesBeforeFollowing).join('')).not.toContain('\x1b[2J')
      }
    } finally {
      drive.disposable.dispose()
    }
  })

  it('keeps the deferred repaint when pending live bytes overflow before the snapshot drains', async () => {
    const drive = await connectVisiblePane()
    vi.useFakeTimers()
    const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    const first = createDeferred<MainSnapshot>()
    getMainBufferSnapshot.mockReturnValueOnce(first.promise)
    getMainBufferSnapshot.mockResolvedValue(modelSnapshot('OVERFLOW_RECOVERED', 1_000_000))
    try {
      await announceMainDrop(64, 1)
      await announceMainDrop(64, 1)
      drive.deliver(OVERFLOW_CHUNK, 64 + OVERFLOW_CHUNK.length)
      first.resolve(modelSnapshot('PRE_OVERFLOW_ONLY', 128))
      await flushAsyncTicks(30)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(30)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
      expect(drive.writtenChunks().join('')).toContain('OVERFLOW_RECOVERED')
      expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
    } finally {
      drive.disposable.dispose()
    }
  })

  it('keeps the existing repaint behavior for a pending-cap marker', async () => {
    const drive = await connectVisiblePane()
    vi.useFakeTimers()
    const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    const first = createDeferred<MainSnapshot>()
    getMainBufferSnapshot.mockReturnValueOnce(first.promise)
    getMainBufferSnapshot.mockResolvedValue(modelSnapshot('PENDING_CAP_RECOVERED', 512))
    try {
      await announceMainDrop(64, 1)
      await announceMainDrop(64, undefined, 'pending-cap')
      first.resolve(modelSnapshot('EARLIER_CAPTURE', 128))
      await flushAsyncTicks(30)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(30)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
      expect(drive.writtenChunks().join('')).toContain('PENDING_CAP_RECOVERED')
    } finally {
      drive.disposable.dispose()
    }
  })

  it('fetches a fresh snapshot when hidden bytes arrived during the first fetch', async () => {
    const drive = await connectVisiblePane()
    vi.useFakeTimers()
    const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    const first = createDeferred<MainSnapshot>()
    const second = createDeferred<MainSnapshot>()
    getMainBufferSnapshot.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    try {
      await announceMainDrop(64, 1)
      await announceMainDrop(64, 1)
      drive.setVisible(false)
      drive.deliver('HIDDEN_AFTER_CAPTURE\r\n', 256)
      drive.setVisible(true)
      first.resolve(modelSnapshot('FIRST_CAPTURE', 128))
      await flushAsyncTicks(30)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(2_100)
      second.resolve(modelSnapshot('FRESH_CAPTURE', 512))
      await flushAsyncTicks(30)
      expect(drive.writtenChunks().join('')).toContain('FRESH_CAPTURE')
      expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
    } finally {
      drive.disposable.dispose()
    }
  })

  it.each(['reject', 'unavailable'] as const)(
    'keeps recovery pending after the first snapshot is %s',
    async (failure) => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const first = createDeferred<MainSnapshot | null>()
      getMainBufferSnapshot.mockReturnValueOnce(first.promise)
      getMainBufferSnapshot.mockResolvedValue(modelSnapshot('RECOVERED_AFTER_REFUSAL', 512))
      try {
        await announceMainDrop(64, 1)
        await announceMainDrop(64, 1, 'unhide')
        if (failure === 'reject') {
          first.reject(new Error('snapshot unavailable'))
        } else {
          first.resolve(null)
        }
        await flushAsyncTicks(30)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
        expect(window.api.pty.ackHiddenOutputRestoreApplied).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(75)
        await flushAsyncTicks(30)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
        expect(drive.writtenChunks().join('')).toContain('RECOVERED_AFTER_REFUSAL')
        expect(window.api.pty.ackHiddenOutputRestoreApplied).toHaveBeenCalledWith(PTY_ID, 1)
        expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
      } finally {
        drive.disposable.dispose()
      }
    }
  )
})
