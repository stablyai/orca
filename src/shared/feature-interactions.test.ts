import { describe, expect, it } from 'vitest'
import {
  getFeatureInteractionUsageBucket,
  hasFeatureInteraction,
  normalizeFeatureInteractionTelemetryBuckets,
  normalizeFeatureInteractions
} from './feature-interactions'

describe('feature interactions', () => {
  it('normalizes persisted records by removing unknown ids and malformed values', () => {
    expect(
      normalizeFeatureInteractions({
        tasks: { firstInteractedAt: 100 },
        browser: { firstInteractedAt: Number.NaN },
        automations: { firstInteractedAt: 200, interactionCount: 3 },
        'browser-grab': { firstInteractedAt: 250, interactionCount: 0 },
        unknown: { firstInteractedAt: 200 },
        'voice-dictation': { firstInteractedAt: 300 }
      })
    ).toEqual({
      tasks: { firstInteractedAt: 100, interactionCount: 1 },
      automations: { firstInteractedAt: 200, interactionCount: 3 },
      'browser-grab': { firstInteractedAt: 250, interactionCount: 1 },
      'voice-dictation': { firstInteractedAt: 300, interactionCount: 1 }
    })
  })

  it('treats only valid known records as interacted', () => {
    expect(
      hasFeatureInteraction({ tasks: { firstInteractedAt: 100, interactionCount: 1 } }, 'tasks')
    ).toBe(true)
    expect(
      hasFeatureInteraction({ tasks: { firstInteractedAt: 100, interactionCount: 1 } }, 'browser')
    ).toBe(false)
    expect(
      hasFeatureInteraction(
        { tasks: { firstInteractedAt: Number.POSITIVE_INFINITY, interactionCount: 1 } },
        'tasks'
      )
    ).toBe(false)
  })

  it('maps interaction counts to the exact top-coded telemetry buckets', () => {
    expect(getFeatureInteractionUsageBucket(0)).toBeNull()
    expect(getFeatureInteractionUsageBucket(1)).toBe('count_1')
    expect(getFeatureInteractionUsageBucket(2)).toBe('count_2')
    expect(getFeatureInteractionUsageBucket(3)).toBe('count_3_4')
    expect(getFeatureInteractionUsageBucket(4)).toBe('count_3_4')
    expect(getFeatureInteractionUsageBucket(5)).toBe('count_5_9')
    expect(getFeatureInteractionUsageBucket(999)).toBe('count_500_999')
    expect(getFeatureInteractionUsageBucket(1000)).toBe('count_1000_plus')
    expect(getFeatureInteractionUsageBucket(1001)).toBe('count_1000_plus')
  })

  it('normalizes persisted telemetry bucket markers by removing unknown ids and buckets', () => {
    expect(
      normalizeFeatureInteractionTelemetryBuckets({
        tasks: 'count_1',
        browser: 'count_1000_plus',
        automations: 'count_4',
        unknown: 'count_1',
        'voice-dictation': null
      })
    ).toEqual({
      tasks: 'count_1',
      browser: 'count_1000_plus'
    })
  })
})
