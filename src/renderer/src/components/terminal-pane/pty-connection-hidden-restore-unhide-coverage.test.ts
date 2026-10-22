import './pty-connection-mocks.spec'
import { describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import {
  announceMainDrop,
  BANNER_FRAGMENT,
  connectVisiblePane,
  installHiddenRestoreFloodSuiteHooks,
  modelSnapshot,
  PTY_ID,
  type MainSnapshot
} from './pty-connection-test-hidden-restore-flood'

// An unhide marker during an in-flight restore is retired by that snapshot when it covers
// the marker's seq, instead of costing a second destructive replay.

describe('hidden-output restore unhide coverage (STA-4869)', () => {
  installHiddenRestoreFloodSuiteHooks()

  it('acknowledges a first-seen unhide episode before newer live output avoids another replay', async () => {
    const drive = await connectVisiblePane()
    vi.useFakeTimers()
    const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    const first = createDeferred<MainSnapshot>()
    getMainBufferSnapshot.mockReturnValueOnce(first.promise)
    getMainBufferSnapshot.mockResolvedValue(modelSnapshot('ACKNOWLEDGED_CAPTURE', 128))
    const ackRestore = vi.mocked(window.api.pty.ackHiddenOutputRestoreApplied)
    try {
      await announceMainDrop(64, undefined, 'pending-cap')
      await announceMainDrop(64, 1, 'unhide')
      first.resolve(modelSnapshot('FIRST_CAPTURE', 128))
      await flushAsyncTicks(40)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
      expect(ackRestore.mock.calls).toEqual([[PTY_ID, undefined]])
      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(40)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
      expect(ackRestore.mock.calls).toEqual([
        [PTY_ID, undefined],
        [PTY_ID, 1]
      ])
      const live = 'LIVE_IMAGE_AFTER_ACK_WINDOW\r\n'
      drive.deliver(live, 128 + live.length)
      await flushAsyncTicks(10)
      expect(drive.writtenChunks().join('')).toContain(live)
      const writesBeforeQuietReveal = drive.writtenChunks().length
      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(40)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
      expect(ackRestore).toHaveBeenCalledTimes(2)
      expect(drive.writtenChunks().slice(writesBeforeQuietReveal).join('')).not.toContain('\x1b[2J')
    } finally {
      drive.disposable.dispose()
    }
  })

  it('keeps the unhide requirement until a repeatedly stale snapshot finally covers it', async () => {
    const drive = await connectVisiblePane()
    vi.useFakeTimers()
    const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    const first = createDeferred<MainSnapshot>()
    getMainBufferSnapshot
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(modelSnapshot('SECOND_STALE_CAPTURE', 128))
      .mockResolvedValueOnce(modelSnapshot('THIRD_COVERING_CAPTURE', 512))
    try {
      await announceMainDrop(64, 1)
      await announceMainDrop(256, 1, 'unhide')
      first.resolve(modelSnapshot('FIRST_STALE_CAPTURE', 128))
      await flushAsyncTicks(100)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(3)
      expect(drive.writtenChunks().join('')).toContain('THIRD_COVERING_CAPTURE')
      expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
    } finally {
      drive.disposable.dispose()
    }
  })

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'does not treat snapshot sequence %s as covering the pending unhide',
    async (seq) => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const first = createDeferred<{
        data: string
        cols: number
        rows: number
        seq?: number
      }>()
      getMainBufferSnapshot.mockReturnValueOnce(first.promise)
      getMainBufferSnapshot.mockResolvedValue(modelSnapshot('FINITE_COVERING_CAPTURE', 512))
      try {
        await announceMainDrop(64, 1)
        await announceMainDrop(256, 1, 'unhide')
        first.resolve({ ...modelSnapshot('UNPROVEN_CAPTURE', 128), seq })
        await flushAsyncTicks(70)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
        expect(drive.writtenChunks().join('')).toContain('FINITE_COVERING_CAPTURE')
      } finally {
        drive.disposable.dispose()
      }
    }
  )

  it('consumes a covered unhide marker received after the response while its replay is parsing', async () => {
    const drive = await connectVisiblePane()
    vi.useFakeTimers()
    const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    getMainBufferSnapshot.mockResolvedValue(modelSnapshot('REPLAY_PARSING', 128))
    const pendingParses: (() => void)[] = []
    const originalWrite = drive.pane.terminal.write.getMockImplementation()
    drive.pane.terminal.write.mockImplementation((data, callback) => {
      if ((data === '' || callback?.name === 'runParsedSteps') && callback) {
        pendingParses.push(callback)
      }
    })
    const finishParsing = async (): Promise<void> => {
      for (let round = 0; round < 10; round += 1) {
        while (pendingParses.length > 0) {
          pendingParses.shift()?.()
        }
        await flushAsyncTicks(10)
      }
    }
    try {
      await announceMainDrop(64, 1)
      await flushAsyncTicks(20)
      expect(drive.writtenChunks().join('')).toContain('REPLAY_PARSING')
      expect(window.api.pty.ackHiddenOutputRestoreApplied).not.toHaveBeenCalled()
      await announceMainDrop(128, 1, 'unhide')
      await finishParsing()
      expect(window.api.pty.ackHiddenOutputRestoreApplied).toHaveBeenCalledWith(PTY_ID, 1)
      const live = 'LIVE_AFTER_PARSED_REPLAY\r\n'
      drive.deliver(live, 128 + live.length)
      await finishParsing()
      const beforeTimer = drive.writtenChunks().length

      await vi.advanceTimersByTimeAsync(2_100)
      await finishParsing()
      expect.soft(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
      expect(drive.writtenChunks().slice(beforeTimer).join('')).not.toContain('\x1b[2J')
    } finally {
      if (originalWrite) {
        drive.pane.terminal.write.mockImplementation(originalWrite)
      }
      drive.disposable.dispose()
    }
  })

  it('does not clear newer live output for an unhide marker the successful snapshot covered', async () => {
    const drive = await connectVisiblePane()
    vi.useFakeTimers()
    const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    const first = createDeferred<MainSnapshot>()
    getMainBufferSnapshot.mockReturnValueOnce(first.promise)
    getMainBufferSnapshot.mockResolvedValue(modelSnapshot('UNNECESSARY_SECOND_REPLAY', 256))
    try {
      await announceMainDrop(64, 1)
      await announceMainDrop(64, 1, 'unhide')
      first.resolve(modelSnapshot('COVERED_DROP', 128))
      await flushAsyncTicks(30)
      expect(window.api.pty.ackHiddenOutputRestoreApplied).toHaveBeenCalledWith(PTY_ID, 1)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

      const live = 'LIVE_AFTER_SUCCESS\r\n'
      drive.deliver(live, 128 + live.length)
      await flushAsyncTicks(10)
      expect(drive.writtenChunks().join('')).toContain(live)
      const beforeTimer = drive.writtenChunks().length
      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(30)

      expect.soft(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
      expect(drive.writtenChunks().slice(beforeTimer).join('')).not.toContain('\x1b[2J')
    } finally {
      drive.disposable.dispose()
    }
  })

  it.each(['pending-cap', 'delivery-heal'] as const)(
    'keeps a %s marker gated right after a covering unhide restore completes',
    async (reason) => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const first = createDeferred<MainSnapshot>()
      getMainBufferSnapshot.mockReturnValueOnce(first.promise)
      getMainBufferSnapshot.mockResolvedValue(modelSnapshot('POST_FLOOD_REPAINT', 512))
      try {
        await announceMainDrop(64, 1)
        await announceMainDrop(64, 1, 'unhide')
        first.resolve(modelSnapshot('COVERED_DROP', 128))
        await flushAsyncTicks(30)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(500)
        await announceMainDrop(256, undefined, reason)
        await flushAsyncTicks(30)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(2_100)
        await flushAsyncTicks(30)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
        expect(drive.writtenChunks().join('')).toContain('POST_FLOOD_REPAINT')
      } finally {
        drive.disposable.dispose()
      }
    }
  )

  it.each([
    { loss: 'a newer episode', markerSeq: 256, episode: 2 },
    {
      loss: 'a repeatedly reported newer episode',
      markerSeq: 256,
      episode: 2,
      repeat: true
    },
    {
      loss: 'a sequence-less repeat after a sequenced marker',
      markerSeq: 256,
      episode: 1,
      fallback: 'unhide'
    },
    {
      loss: 'a pending cap after a sequenced marker',
      markerSeq: 256,
      episode: 1,
      fallback: 'pending-cap'
    },
    {
      loss: 'covered bytes in a newly reported episode',
      markerSeq: 64,
      episode: 2
    },
    {
      loss: 'covered bytes without an episode',
      markerSeq: 64,
      episode: undefined
    },
    { loss: 'newer bytes in the same episode', markerSeq: 256, episode: 1 },
    { loss: 'an episode-less marker', markerSeq: 256, episode: undefined },
    { loss: 'a sequence-less marker', markerSeq: undefined, episode: 1 }
  ])('still repaints $loss reported while the older snapshot was fetching', async (scenario) => {
    const { markerSeq, episode } = scenario
    const drive = await connectVisiblePane()
    vi.useFakeTimers()
    const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    const first = createDeferred<MainSnapshot>()
    getMainBufferSnapshot.mockReturnValueOnce(first.promise)
    getMainBufferSnapshot.mockResolvedValue(modelSnapshot('NEW_EPISODE_RECOVERED', 512))
    try {
      await announceMainDrop(64, 1)
      await announceMainDrop(markerSeq, episode, 'unhide')
      if ('repeat' in scenario && scenario.repeat) {
        await announceMainDrop(markerSeq, episode, 'unhide')
      }
      if ('fallback' in scenario && scenario.fallback === 'unhide') {
        await announceMainDrop(undefined, episode, 'unhide')
      } else if ('fallback' in scenario && scenario.fallback === 'pending-cap') {
        await announceMainDrop(undefined, undefined, 'pending-cap')
      }
      first.resolve(modelSnapshot('ONLY_OLD_EPISODE_COVERED', 128))
      await flushAsyncTicks(30)
      expect(window.api.pty.ackHiddenOutputRestoreApplied).toHaveBeenCalledWith(PTY_ID, 1)

      const repairAlreadyPainted = getMainBufferSnapshot.mock.calls.length === 2
      const live = 'LIVE_AFTER_COVERING_REPAIR\r\n'
      if (repairAlreadyPainted) {
        drive.deliver(live, 512 + live.length)
        await flushAsyncTicks(10)
      }
      const writesBeforeTimer = drive.writtenChunks().length

      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(30)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
      if (repairAlreadyPainted) {
        expect(drive.writtenChunks().slice(writesBeforeTimer).join('')).not.toContain('\x1b[2J')
      }
      expect(drive.writtenChunks().join('')).toContain('NEW_EPISODE_RECOVERED')
      if (episode !== undefined) {
        expect(window.api.pty.ackHiddenOutputRestoreApplied).toHaveBeenCalledWith(PTY_ID, episode)
      }
    } finally {
      drive.disposable.dispose()
    }
  })
})
