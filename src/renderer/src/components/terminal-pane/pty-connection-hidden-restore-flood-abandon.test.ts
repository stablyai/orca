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
  type MainSnapshot,
  type PaneDrive
} from './pty-connection-test-hidden-restore-flood'

// STA-4869 — routes R3 (pending-queue overflow, pty-connection.ts:7696) and R4
// (loop iteration cap, 7702) end in the QUIET abandon, which trades the loss
// banner for one deferred post-flood repaint. Same invariant as the non-quiet
// routes: every retained byte is reconciled exactly once, or the loss is
// disclosed. These cases must also survive the pane being scrolled back or
// hidden when the deferred repaint comes due.

const { warnTerminalLifecycleAnomaly } = vi.hoisted(() => ({
  warnTerminalLifecycleAnomaly: vi.fn()
}))

// The iteration-cap warning is the only externally visible proof that R4's
// backstop fired rather than the loop finishing on its own.
vi.mock('./terminal-lifecycle-diagnostics', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  warnTerminalLifecycleAnomaly
}))

const R3_MARKER = 'R3-LOST-4d17'
const R4_MARKER = 'R4-LOST-8ba0'

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

type Disclosure = {
  bannerWrites: number
  markerWrites: number
  disclosedOrRecovered: boolean
}

function observeDisclosure(drive: PaneDrive, marker: string): Disclosure {
  const written = drive.writtenChunks()
  const bannerWrites = written.filter((data) => data.includes(BANNER_FRAGMENT)).length
  const markerWrites = countOccurrences(written.join(''), marker)
  return {
    bannerWrites,
    markerWrites,
    disclosedOrRecovered: bannerWrites > 0 || markerWrites === 1
  }
}

function expectDisclosedOrRecovered(disclosure: Disclosure): void {
  expect(
    disclosure.disclosedOrRecovered,
    `hidden output was neither reconciled nor disclosed: ${JSON.stringify(disclosure)}`
  ).toBe(true)
}

describe('hidden-output restore quiet abandonment (STA-4869)', () => {
  installHiddenRestoreFloodSuiteHooks()

  // ── R3: foreground pending-queue overflow ───────────────────────────────
  describe('R3 pending-queue overflow', () => {
    /** Drives one restore into a 512KB queue overflow and returns once the
     *  quiet abandon has run. */
    async function overflowRestoreQueue(drive: PaneDrive): Promise<void> {
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const firstSnapshot = createDeferred<MainSnapshot>()
      getMainBufferSnapshot.mockReturnValueOnce(firstSnapshot.promise)
      await announceMainDrop(64)
      await flushAsyncTicks(20)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

      // The live stream outruns fetch+replay and blows the queue cap.
      drive.deliver(OVERFLOW_CHUNK, 64 + OVERFLOW_CHUNK.length)
      drive.deliver(OVERFLOW_CHUNK, 64 + 2 * OVERFLOW_CHUNK.length)
      // Resolve inside the 750ms foreground deadline so the drain, not the
      // deadline timer, owns the abandonment.
      firstSnapshot.resolve(modelSnapshot('pre-overflow-model', 64))
      await flushAsyncTicks(20)

      // Proof the overflow arm ran: the snapshot replayed, and the queued
      // backlog was discarded rather than drained under it.
      const written = drive.writtenChunks().join('')
      expect(written).toContain('pre-overflow-model')
      expect(written).not.toContain('o'.repeat(1024))
    }

    it('[invariant] reconciles the retained bytes through the deferred post-flood repaint', async () => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      await overflowRestoreQueue(drive)

      expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
      getMainBufferSnapshot.mockResolvedValue(modelSnapshot(R3_MARKER, 4096))
      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(20)

      const disclosure = observeDisclosure(drive, R3_MARKER)
      expect(disclosure.markerWrites).toBeLessThanOrEqual(1)
      expectDisclosedOrRecovered(disclosure)
      drive.disposable.dispose()
    })

    it('[invariant] keeps recovery armed while the user reads scrollback', async () => {
      const { markTerminalFollowOutput, markTerminalPinnedViewport } =
        await import('@/lib/pane-manager/terminal-scroll-intent')
      const drive = await connectVisiblePane()
      drive.pane.terminal.buffer.active.baseY = 100
      drive.pane.terminal.buffer.active.viewportY = 42
      markTerminalPinnedViewport(drive.pane.terminal)
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      await overflowRestoreQueue(drive)

      getMainBufferSnapshot.mockResolvedValue(modelSnapshot(R4_MARKER, 4096))
      await vi.advanceTimersByTimeAsync(60_000)
      await flushAsyncTicks(20)
      // Parked, not abandoned: the repaint must not yank the viewport, and must
      // not claim a loss it can still heal.
      expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
      expect(drive.pane.terminal.buffer.active.viewportY).toBe(42)

      // A background stint must not consume the parked recovery either.
      drive.setVisible(false)
      await vi.advanceTimersByTimeAsync(60_000)
      drive.setVisible(true)
      await flushAsyncTicks(20)

      drive.pane.terminal.buffer.active.viewportY = drive.pane.terminal.buffer.active.baseY
      markTerminalFollowOutput(drive.pane.terminal)
      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(20)

      const disclosure = observeDisclosure(drive, R4_MARKER)
      expect(disclosure.markerWrites).toBeLessThanOrEqual(1)
      expectDisclosedOrRecovered(disclosure)
      drive.disposable.dispose()
    })
  })

  // ── R4: restore loop iteration cap ──────────────────────────────────────
  describe('R4 loop iteration cap', () => {
    it('[invariant] reconciles the retained bytes after the iteration backstop fires', async () => {
      const drive = await connectVisiblePane()
      vi.useFakeTimers()
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      const rounds = [0, 1, 2].map(() => createDeferred<MainSnapshot>())
      for (const round of rounds) {
        getMainBufferSnapshot.mockReturnValueOnce(round.promise)
      }
      await announceMainDrop(64)
      await flushAsyncTicks(20)

      // Each round: the pane goes background long enough for one chunk to arrive
      // with a restore in flight, which marks the in-flight snapshot stale and
      // sends the loop around again.
      for (const [index, round] of rounds.entries()) {
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(index + 1)
        drive.setVisible(false)
        drive.deliver(`stale-round-${index}\r\n`, 128 + index * 32)
        drive.setVisible(true)
        round.resolve(modelSnapshot(`round-${index}-model`, 64 + index))
        await flushAsyncTicks(20)
      }

      // The backstop cut the loop without a banner; the deferred repaint owes
      // the pane its bytes.
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(3)
      expect(warnTerminalLifecycleAnomaly).toHaveBeenCalledWith(
        'hidden output restore hit its iteration cap',
        expect.objectContaining({ ptyId: PTY_ID })
      )
      expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
      getMainBufferSnapshot.mockResolvedValue(modelSnapshot(R4_MARKER, 8192))
      await vi.advanceTimersByTimeAsync(2_100)
      await flushAsyncTicks(20)

      const disclosure = observeDisclosure(drive, R4_MARKER)
      expect(disclosure.markerWrites).toBeLessThanOrEqual(1)
      expectDisclosedOrRecovered(disclosure)
      drive.disposable.dispose()
    })
  })
})
