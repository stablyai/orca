// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPanelWatchdog } from './plugin-panel-watchdog'
import { resetStaleDocumentVisibilityForTesting } from '../terminal-pane/stale-document-visibility'

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('createPanelWatchdog visibility parking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setVisibility('visible')
    resetStaleDocumentVisibilityForTesting()
  })
  afterEach(() => {
    vi.useRealTimers()
    setVisibility('visible')
    resetStaleDocumentVisibilityForTesting()
  })

  it('parks pings while hidden and resumes on the becoming-visible pass, not the next interval', () => {
    const sendPing = vi.fn()
    const watchdog = createPanelWatchdog({
      sendPing,
      onUnresponsive: vi.fn(),
      pingIntervalMs: 10_000,
      pongTimeoutMs: 5_000
    })

    watchdog.start()
    expect(sendPing).toHaveBeenCalledTimes(1)
    watchdog.handlePong(0)

    setVisibility('hidden')
    vi.advanceTimersByTime(30_000)
    expect(sendPing).toHaveBeenCalledTimes(1)

    // The resume pings immediately rather than waiting out the remaining interval.
    setVisibility('visible')
    expect(sendPing).toHaveBeenCalledTimes(2)

    watchdog.stop()
  })

  it('does not park forever when macOS wedges visibilityState at hidden', () => {
    const sendPing = vi.fn()
    const watchdog = createPanelWatchdog({
      sendPing,
      onUnresponsive: vi.fn(),
      pingIntervalMs: 10_000,
      pongTimeoutMs: 5_000
    })

    watchdog.start()
    watchdog.handlePong(0)
    setVisibility('hidden')
    vi.advanceTimersByTime(20_000)
    expect(sendPing).toHaveBeenCalledTimes(1)

    // Real user input while the document still claims hidden proves the occlusion
    // tracker is stale; the watchdog must start pinging again without a visibilitychange.
    document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(sendPing).toHaveBeenCalledTimes(2)

    watchdog.stop()
  })

  it('removes its visibility listener on stop', () => {
    const sendPing = vi.fn()
    const watchdog = createPanelWatchdog({
      sendPing,
      onUnresponsive: vi.fn(),
      pingIntervalMs: 10_000,
      pongTimeoutMs: 5_000
    })

    watchdog.start()
    watchdog.handlePong(0)
    watchdog.stop()
    const callsAtStop = sendPing.mock.calls.length

    setVisibility('hidden')
    setVisibility('visible')
    expect(sendPing).toHaveBeenCalledTimes(callsAtStop)
  })
})
