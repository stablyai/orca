import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState } from '../../../shared/onboarding-defaults'
import { markOnboardingProjectAdded } from './onboarding-project-checklist'

const mocks = vi.hoisted(() => ({
  track: vi.fn(),
  onboardingGet: vi.fn(),
  onboardingUpdate: vi.fn()
}))

vi.mock('@/lib/telemetry', () => ({
  track: mocks.track
}))

describe('markOnboardingProjectAdded', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.onboardingGet.mockResolvedValue(getDefaultOnboardingState())
    mocks.onboardingUpdate.mockResolvedValue(getDefaultOnboardingState())
    vi.stubGlobal('window', {
      api: {
        onboarding: {
          get: mocks.onboardingGet,
          update: mocks.onboardingUpdate
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not duplicate checklist telemetry for an already completed item', async () => {
    mocks.onboardingGet.mockResolvedValue({
      ...getDefaultOnboardingState(),
      checklist: { ...getDefaultOnboardingState().checklist, addedRepo: true }
    })

    await markOnboardingProjectAdded('addedRepo')

    expect(mocks.onboardingUpdate).not.toHaveBeenCalled()
    expect(mocks.track).not.toHaveBeenCalled()
  })
})
