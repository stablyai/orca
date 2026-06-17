import { beforeEach, describe, expect, it, vi } from 'vitest'

const trackMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/telemetry', () => ({
  track: trackMock
}))

import {
  buildCompletedOnboardingNotificationSettings,
  buildOnboardingDismissedPayload,
  trackOnboardingDismissed
} from './use-onboarding-flow-persistence'

describe('onboarding flow persistence', () => {
  beforeEach(() => {
    trackMock.mockClear()
  })

  it('builds dismissed telemetry with the triggering advance path', () => {
    expect(
      buildOnboardingDismissedPayload(3, {
        durationMs: 250,
        advancedVia: 'keyboard'
      })
    ).toEqual({
      last_step: 3,
      duration_ms: 250,
      advanced_via: 'keyboard'
    })
  })

  it('tracks dismissed onboarding telemetry with the triggering advance path', () => {
    trackOnboardingDismissed(3, {
      durationMs: 250,
      advancedVia: 'keyboard'
    })

    expect(trackMock).toHaveBeenCalledWith('onboarding_dismissed', {
      last_step: 3,
      duration_ms: 250,
      advanced_via: 'keyboard'
    })
  })

  it('preserves explicit focus notification suppression when completing onboarding', () => {
    const notifications = buildCompletedOnboardingNotificationSettings({
      enabled: false,
      agentTaskComplete: false,
      terminalBell: false,
      suppressWhenFocused: false,
      customSoundId: 'two-tone',
      customSoundPath: null,
      customSoundVolume: 60
    })

    expect(notifications).toEqual({
      enabled: true,
      agentTaskComplete: true,
      terminalBell: true,
      suppressWhenFocused: false,
      customSoundId: 'two-tone',
      customSoundPath: null,
      customSoundVolume: 60
    })
  })
})
