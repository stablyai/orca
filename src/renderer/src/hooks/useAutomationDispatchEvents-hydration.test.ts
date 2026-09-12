// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutomationDispatchEvents } from './useAutomationDispatchEvents'

const mockUnsubscribe = vi.fn()
const mockOnDispatchRequested = vi.fn(() => mockUnsubscribe)
const mockRendererReady = vi.fn()

vi.mock('./automation-dispatch-handler', () => ({
  handleAutomationDispatchRequest: vi.fn()
}))

describe('useAutomationDispatchEvents hydration gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        automations: {
          onDispatchRequested: mockOnDispatchRequested,
          rendererReady: mockRendererReady
        }
      }
    })
  })

  it('releases scheduled runs once when startup hydration becomes ready', () => {
    const hook = renderHook(
      ({ rendererReady }: { rendererReady: boolean }) => useAutomationDispatchEvents(rendererReady),
      { initialProps: { rendererReady: false } }
    )

    expect(mockOnDispatchRequested).toHaveBeenCalledOnce()
    expect(mockRendererReady).not.toHaveBeenCalled()

    hook.rerender({ rendererReady: true })
    expect(mockOnDispatchRequested).toHaveBeenCalledOnce()
    expect(mockRendererReady).toHaveBeenCalledOnce()

    hook.rerender({ rendererReady: true })
    expect(mockRendererReady).toHaveBeenCalledOnce()

    hook.unmount()
    expect(mockUnsubscribe).toHaveBeenCalledOnce()
  })
})
