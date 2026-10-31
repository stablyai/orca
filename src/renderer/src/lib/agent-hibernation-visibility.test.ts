// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  startAgentHibernationCoordinator,
  stopAgentHibernationCoordinator
} from './agent-hibernation-coordinator'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/stale-document-visibility'

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('agent hibernation coordinator visibility wiring', () => {
  beforeEach(() => {
    setVisibility('visible')
    resetStaleDocumentVisibilityForTesting()
  })
  afterEach(async () => {
    const { resetAgentHibernationCoordinatorFixture } =
      await import('./agent-hibernation-coordinator-test-fixture')
    resetAgentHibernationCoordinatorFixture()
    resetStaleDocumentVisibilityForTesting()
    setVisibility('visible')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('subscribes to the becoming-visible pass on start and unsubscribes on stop', async () => {
    // Keep happy-dom's event target when the state fixture stubs window.
    const browserWindow = window
    const { installEligibleState, NOW, LEAF } =
      await import('./agent-hibernation-coordinator-test-fixture')
    vi.stubGlobal('window', browserWindow)
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))

    startAgentHibernationCoordinator({ intervalMs: 1_000, now: () => NOW })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(shutdown).not.toHaveBeenCalled()

    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(shutdown).not.toHaveBeenCalled()

    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(shutdown).toHaveBeenCalledExactlyOnceWith('wt-bg', {
      paneKey: `tab-1:${LEAF}`,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-1'
    })

    shutdown.mockClear()
    stopAgentHibernationCoordinator()
    setVisibility('hidden')
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(0)
    setVisibility('hidden')
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(shutdown).not.toHaveBeenCalled()
  })
})
