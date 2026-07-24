/**
 * Issue #8715 — OMP: scroll position resets to top when switching tabs.
 *
 * Root cause: OMP (like other full-screen TUIs) runs in xterm's alternate
 * buffer. `scheduleSplitScrollRestore` deliberately skips scroll restore for
 * `bufferType === 'alternate'` because restore-during-draw knocks the TUI
 * cursor (#1298). When the user scrolls inside OMP, switches tabs, and returns,
 * there is no path that re-pins the TUI viewport — it reappears at the top.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/lib/pane-manager/repro-8715-omp-alt-screen-scroll.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleSplitScrollRestore } from './pane-split-scroll'
import { isResumableTuiAgent } from '../../../../shared/agent-session-resume'
import type { ManagedPaneInternal, ScrollState } from './pane-manager-types'

const splitScrollSource = readFileSync(join(__dirname, 'pane-split-scroll.ts'), 'utf8')

function makePane(id: number, bufferType: 'normal' | 'alternate'): ManagedPaneInternal {
  return {
    id,
    pendingSplitScrollTimerId: null,
    pendingSplitScrollRafIds: [],
    pendingSplitScrollState: {
      viewportY: 42,
      baseY: 0,
      bufferType
    } as ScrollState,
    pendingSplitScrollBufferDisposable: null,
    terminal: {
      rows: 24,
      buffer: {
        active: { type: bufferType, viewportY: 0, baseY: 0 },
        onBufferChange: () => ({ dispose: () => {} })
      },
      scrollToLine: vi.fn(),
      refresh: vi.fn()
    }
  } as unknown as ManagedPaneInternal
}

describe('#8715 OMP / alt-screen scroll not restored on tab switch', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('documents the alternate-buffer early-return that drops scroll restore', () => {
    expect(splitScrollSource).toMatch(/scrollState\.bufferType === 'alternate'/)
    expect(splitScrollSource).toMatch(/restore-during-draw knocks its cursor/)
  })

  it('skips scrollToLine when the captured buffer is alternate', () => {
    vi.useFakeTimers()
    // requestAnimationFrame polyfill for node
    const rafIds: (() => void)[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafIds.push(() => cb(0))
      return rafIds.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})

    const pane = makePane(1, 'alternate')
    const reattachWebgl = vi.fn()
    const scrollState: ScrollState = {
      viewportY: 42,
      baseY: 0,
      bufferType: 'alternate'
    }

    scheduleSplitScrollRestore(
      (id) => (id === 1 ? pane : undefined),
      1,
      scrollState,
      () => false,
      reattachWebgl
    )

    // Drain rAF chain
    while (rafIds.length > 0) {
      const next = rafIds.shift()!
      next()
    }
    vi.advanceTimersByTime(250)

    expect(pane.terminal.scrollToLine).not.toHaveBeenCalled()
  })

  it('OMP is a full-screen TUI agent (not cold-resumable) that relies on live alt-screen', () => {
    expect(isResumableTuiAgent('omp')).toBe(false)
  })
})
