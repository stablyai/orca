import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createForegroundImmediateBudget } from './foreground-output-budgets'
import { bindForegroundOutputRefresh } from './foreground-output-refresh'
import { createTerminalInputEchoDelay } from './terminal-input-echo-delay'
import { bindWritePtyOutputToXterm } from './write-pty-output-to-xterm'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { discardTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-queue-registry'

function createMockSession(overrides?: { hasWebgl?: boolean }): {
  session: ConnectPanePtySession
  writes: string[]
} {
  const writes: string[] = []
  const terminal = {
    cols: 80,
    rows: 24,
    buffer: { active: { viewportY: 0, baseY: 0 } },
    write: vi.fn((data: string, cb?: () => void) => {
      writes.push(data)
      cb?.()
    }),
    refresh: vi.fn()
  }
  const hasWebgl = overrides?.hasWebgl ?? true
  const session = {
    pane: { id: 1, terminal },
    manager: {
      getActivePane: () => ({ id: 1 }),
      hasWebglRenderer: () => hasWebgl
    },
    deps: {
      isActiveRef: { current: true },
      isVisibleRef: { current: true }
    },
    transport: {
      getPtyId: () => 'wt-1:pty-1',
      setOutputPaused: vi.fn()
    },
    disposed: false,
    idleCursorReset: {
      processOutput: (data: string) => data,
      request: () => null
    },
    kittyKeyboardModes: { scan: vi.fn() },
    inputEchoDelay: createTerminalInputEchoDelay(),
    resetHiddenOutputRestoreIfPtyChanged: vi.fn(),
    canUseHiddenOutputSnapshot: () => false,
    shouldSnapshotHiddenCodexOutput: false,
    shouldHoldSynchronizedForegroundOutput: true,
    shouldProtectNativeWindowsSynchronizedOutput: false,
    shouldApplyNativeWindowsRewriteRefresh: false,
    shouldApplyWindowsRendererUnicodeRefresh: false,
    synchronizedForegroundOutputActive: false,
    synchronizedForegroundMarkerTail: '',
    synchronizedForegroundFrameInteractive: false,
    synchronizedForegroundInteractivePresentPending: false,
    scheduleForegroundGridDriftCheck: vi.fn(),
    lastTerminalInputAt: Number.NEGATIVE_INFINITY,
    lastInteractiveRedrawInputAt: Number.NEGATIVE_INFINITY,
    foregroundImmediateBudget: createForegroundImmediateBudget(),
    foregroundRewriteChunkEndedWithCarriageReturn: false,
    foregroundRewriteCsiScanTail: '',
    foregroundRendererRiskOutputPrefersRenderRefresh: () => false,
    markHiddenOutputRestoreNeeded: vi.fn(),
    streamPosition: {
      admit: (_ptyId: string, data: string) => data,
      invalidate: vi.fn()
    }
  } as unknown as ConnectPanePtySession
  bindForegroundOutputRefresh(session)
  bindWritePtyOutputToXterm(session)
  return { session, writes }
}

describe('foreground redraw coalescing & WebGL refresh gating', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds split DEC ?2026 synchronized frames on non-ConPTY hosts and drains immediately on ?2026l', () => {
    const { session, writes } = createMockSession({ hasWebgl: true })
    try {
      session.writePtyOutputToXterm('\x1b[?2026h\x1b[Hframe-part-1 ', true)
      session.writePtyOutputToXterm('frame-part-2 ', true)
      expect(writes).toEqual([])

      session.writePtyOutputToXterm('frame-end\x1b[?2026l', true)
      expect(writes).toEqual([])

      // Drains on scheduleDrain(0) without waiting for ConPTY's 1000ms cursor-restore coalesce timer.
      vi.advanceTimersByTime(1)
      expect(writes).toEqual(['\x1b[?2026h\x1b[Hframe-part-1 frame-part-2 frame-end\x1b[?2026l'])
      expect(session.pane.terminal.refresh).not.toHaveBeenCalled()
    } finally {
      discardTerminalOutput(session.pane.terminal)
    }
  })

  it('skips redundant DOM rewrite refresh when WebGL is active on non-ConPTY hosts', () => {
    const webgl = createMockSession({ hasWebgl: true })
    const dom = createMockSession({ hasWebgl: false })
    expect(webgl.session.shouldForceForegroundRenderRefresh('\rspinner\x1b[K')).toEqual({
      refresh: false,
      inPlaceRewrite: false
    })
    expect(dom.session.shouldForceForegroundRenderRefresh('\rspinner\x1b[K')).toEqual({
      refresh: true,
      inPlaceRewrite: true
    })
  })

  it('coalesces sustained unattended streaming bursts while keeping interactive input immediate', () => {
    const { session } = createMockSession({ hasWebgl: true })
    const chunk = 'x'.repeat(1024)
    expect(session.isLatencySensitiveForegroundOutput(chunk)).toBe(true)
    expect(session.isLatencySensitiveForegroundOutput(chunk)).toBe(true)
    expect(session.isLatencySensitiveForegroundOutput(chunk)).toBe(true)
    expect(session.isLatencySensitiveForegroundOutput(chunk)).toBe(true)
    // 5th 1 KiB unattended chunk in the same 500ms window exceeds the 4 KiB unattended budget.
    expect(session.isLatencySensitiveForegroundOutput(chunk)).toBe(false)

    // User input immediately restores the 128 KiB interactive budget.
    session.lastInteractiveRedrawInputAt = performance.now()
    expect(session.isLatencySensitiveForegroundOutput(`\x1b[2K${chunk}`)).toBe(true)
  })
})
