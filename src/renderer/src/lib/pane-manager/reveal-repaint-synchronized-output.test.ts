import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { schedulePaneRevealRepaint, schedulePaneRevealPresent } from './pane-reveal-repaint'
import type { ManagedPaneInternal } from './pane-manager-types'

vi.mock('./pane-webgl-reattach', () => ({
  reattachWebglIfNeeded: vi.fn()
}))
vi.mock('./pane-manager-registry', () => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn()
}))

/**
 * Why these tests exist: xterm's `RenderService.refreshRows` returns at its
 * `_isPaused` check BEFORE it reaches `bufferRows`, and `bufferRows` is the only
 * place the 1s synchronized-output watchdog is armed. So a pane hidden mid
 * `?2026h` holds the latch with no timer behind it — indefinitely — and every
 * repaint Orca owns renders zero rows against a perfectly correct buffer.
 */
function createPane(synchronizedOutput: boolean): ManagedPaneInternal {
  const decPrivateModes = { synchronizedOutput }
  return {
    terminal: {
      rows: 24,
      refresh: vi.fn(),
      _core: {
        coreService: { decPrivateModes },
        _renderService: { _syncOutputHandler: { flush: vi.fn() } }
      }
    }
  } as unknown as ManagedPaneInternal
}

function modesOf(pane: ManagedPaneInternal): { synchronizedOutput: boolean } {
  return (
    pane.terminal as unknown as {
      _core: { coreService: { decPrivateModes: { synchronizedOutput: boolean } } }
    }
  )._core.coreService.decPrivateModes
}

beforeEach(() => {
  vi.useFakeTimers()
  // Two rAFs, then the settled-frame callback runs.
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    setTimeout(cb, 0)
    return 1
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('reveal repaint releases an abandoned synchronized-output latch', () => {
  it('clears the latch on the reveal path so the repaint is not swallowed', async () => {
    const pane = createPane(true)
    schedulePaneRevealRepaint(() => [pane])
    await vi.runAllTimersAsync()
    expect(modesOf(pane).synchronizedOutput).toBe(false)
  })

  it('leaves an unlatched pane untouched on the reveal path', async () => {
    const pane = createPane(false)
    schedulePaneRevealRepaint(() => [pane])
    await vi.runAllTimersAsync()
    expect(modesOf(pane).synchronizedOutput).toBe(false)
  })

  /**
   * The defect in the reverted #10907: it also released on the plain-refocus
   * present path. A refocus never hid its panes, so a latch there is a LIVE
   * frame mid-flight and clearing it presents a half-drawn frame. Agent TUIs
   * write these brackets many times a second, so that path would tear a frame
   * on ordinary window refocus.
   */
  it('does NOT clear the latch on the plain-refocus present path', async () => {
    const pane = createPane(true)
    schedulePaneRevealPresent(() => [pane])
    await vi.runAllTimersAsync()
    expect(modesOf(pane).synchronizedOutput).toBe(true)
  })
})
