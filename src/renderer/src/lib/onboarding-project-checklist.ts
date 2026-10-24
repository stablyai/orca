import { track } from '@/lib/telemetry'
import type { OnboardingState } from '../../../shared/onboarding-state-types'

export type OnboardingProjectChecklistItem = 'addedRepo' | 'addedFolder'

/** Returns the onboarding state read before marking, so callers can tell a first add from a later one. */
export async function markOnboardingProjectAdded(
  item: OnboardingProjectChecklistItem
): Promise<OnboardingState | null> {
  if (typeof window === 'undefined' || !window.api?.onboarding) {
    return null
  }
  const onboarding = await window.api.onboarding.get().catch(() => null)
  if (!onboarding || onboarding.checklist[item]) {
    return onboarding
  }

  const checklist: Partial<OnboardingState['checklist']> = {}
  checklist[item] = true
  try {
    await window.api.onboarding.update({ checklist })
  } catch (err) {
    console.warn('[onboarding] Failed to update project checklist item:', err)
    return onboarding
  }

  track('activation_checklist_item_completed', {
    item,
    time_since_completed_ms: 0
  })
  return onboarding
}
