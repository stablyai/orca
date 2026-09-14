import type { PreloadApi } from '../../../../preload/api-types'
import { ONBOARDING_FLOW_VERSION, getDefaultOnboardingState } from '../../../../shared/constants'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'
import { ONBOARDING_STORAGE_KEY, readJson, writeJson } from './web-storage'

export function getStoredOnboarding(): OnboardingState {
  const storedRaw = window.localStorage.getItem(ONBOARDING_STORAGE_KEY)
  if (storedRaw) {
    const stored = readJson(ONBOARDING_STORAGE_KEY, getDefaultOnboardingState())
    if (stored.checklist.dismissed) {
      return stored
    }
    const closed = closeWebOnboarding(stored)
    writeJson(ONBOARDING_STORAGE_KEY, closed)
    return closed
  }
  const closed = closeWebOnboarding(getDefaultOnboardingState())
  // Why: paired clients already have an Orca server; skip desktop first-run onboarding that would probe browser-local tools.
  writeJson(ONBOARDING_STORAGE_KEY, closed)
  return closed
}

export function closeWebOnboarding(base: OnboardingState): OnboardingState {
  return {
    ...base,
    flowVersion: ONBOARDING_FLOW_VERSION,
    closedAt: Date.now(),
    outcome: 'dismissed',
    checklist: {
      ...base.checklist,
      dismissed: true
    }
  }
}

export function createWebOnboardingApi(): Partial<PreloadApi> {
  return {
    onboarding: {
      get: () => Promise.resolve(getStoredOnboarding()),
      update: async (updates) => {
        const current = getStoredOnboarding()
        const next: OnboardingState = {
          ...current,
          ...updates,
          flowVersion: ONBOARDING_FLOW_VERSION,
          checklist: {
            ...current.checklist,
            ...updates.checklist
          }
        }
        writeJson(ONBOARDING_STORAGE_KEY, next)
        return next
      }
    }
  }
}
