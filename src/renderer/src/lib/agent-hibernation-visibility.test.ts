// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetAgentHibernationCoordinatorForTests,
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
  afterEach(() => {
    resetAgentHibernationCoordinatorForTests()
    resetStaleDocumentVisibilityForTesting()
    setVisibility('visible')
    vi.restoreAllMocks()
  })

  it('subscribes to the becoming-visible pass on start and unsubscribes on stop', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')

    startAgentHibernationCoordinator({ intervalMs: 60_000, now: () => 0 })
    expect(add.mock.calls.some(([type]) => type === 'visibilitychange')).toBe(true)

    stopAgentHibernationCoordinator()
    expect(remove.mock.calls.some(([type]) => type === 'visibilitychange')).toBe(true)
  })

  it('leaves no visibility listener behind after a start/stop cycle', () => {
    startAgentHibernationCoordinator({ intervalMs: 60_000, now: () => 0 })
    stopAgentHibernationCoordinator()

    const afterStop = vi.spyOn(document, 'addEventListener')
    setVisibility('hidden')
    setVisibility('visible')
    // A stopped coordinator must not react to visibility at all.
    expect(afterStop).not.toHaveBeenCalled()
  })
})
