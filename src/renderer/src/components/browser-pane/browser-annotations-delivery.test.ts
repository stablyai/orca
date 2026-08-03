import { describe, expect, it, vi } from 'vitest'
import { applyBrowserAnnotationsDeliveredToAgent } from './browser-annotations-delivery'

describe('applyBrowserAnnotationsDeliveredToAgent', () => {
  it('records the agent-handoff interaction then clears page annotations', () => {
    const calls: string[] = []
    const clearBrowserPageAnnotations = vi.fn((pageId: string) => {
      calls.push(`clear:${pageId}`)
    })
    const recordFeatureInteraction = vi.fn((featureId: 'browser-annotations-sent-to-agent') => {
      calls.push(`record:${featureId}`)
    })
    const resetLocalUiState = vi.fn(() => {
      calls.push('reset-ui')
    })

    applyBrowserAnnotationsDeliveredToAgent({
      pageId: 'page-1',
      clearBrowserPageAnnotations,
      recordFeatureInteraction,
      resetLocalUiState
    })

    expect(recordFeatureInteraction).toHaveBeenCalledWith('browser-annotations-sent-to-agent')
    expect(clearBrowserPageAnnotations).toHaveBeenCalledWith('page-1')
    expect(resetLocalUiState).toHaveBeenCalledOnce()
    // Why: telemetry first, then local UI, then store clear — store last so a
    // failed interaction recorder still doesn't leave stale pins if we later
    // reorder; today order documents intentional side-effect sequence.
    expect(calls).toEqual(['record:browser-annotations-sent-to-agent', 'reset-ui', 'clear:page-1'])
  })

  it('clears annotations even when local UI reset is omitted', () => {
    const clearBrowserPageAnnotations = vi.fn()
    const recordFeatureInteraction = vi.fn()

    applyBrowserAnnotationsDeliveredToAgent({
      pageId: 'page-2',
      clearBrowserPageAnnotations,
      recordFeatureInteraction
    })

    expect(clearBrowserPageAnnotations).toHaveBeenCalledWith('page-2')
  })
})
