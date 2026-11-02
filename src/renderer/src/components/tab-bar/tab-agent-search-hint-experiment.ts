import { track } from '@/lib/telemetry'

const EXPOSURE_KEY = 'orca.tabAgentSearchHint.v1'
type Cohort = 'control' | 'treatment'
type HintAction = 'dismissed' | 'try_example' | 'agent_selected'

export type TabAgentSearchHintExperiment = {
  claimHint: () => boolean
  trackAction: (action: HintAction) => void
}

export function getTabAgentSearchHintCohort(): Cohort | null {
  try {
    const value = window.localStorage.getItem(EXPOSURE_KEY)
    return value === 'control' || value === 'treatment' ? value : null
  } catch {
    return null
  }
}

// Measure from exposure until this menu session closes or records its first agent selection.
export function createTabAgentSearchHintExperiment(): TabAgentSearchHintExperiment {
  let activeCohort: Cohort | null = null
  return {
    claimHint: () => {
      try {
        if (window.localStorage.getItem(EXPOSURE_KEY) !== null) {
          return false
        }
        const cohort: Cohort =
          crypto.getRandomValues(new Uint8Array(1))[0] < 128 ? 'control' : 'treatment'
        // Persist exposure before showing; closing the menu or restarting never offers it again.
        window.localStorage.setItem(EXPOSURE_KEY, cohort)
        activeCohort = cohort
        track('tab_agent_search_hint_exposure', { experiment_cohort: cohort })
        return cohort === 'treatment'
      } catch {
        // Without durable storage, suppress the hint rather than repeat it.
        return false
      }
    },
    trackAction: (action) => {
      const cohort = activeCohort
      if (!cohort) {
        return
      }
      if (action === 'agent_selected') {
        activeCohort = null
      }
      track('tab_agent_search_hint_action', { experiment_cohort: cohort, action })
    }
  }
}
