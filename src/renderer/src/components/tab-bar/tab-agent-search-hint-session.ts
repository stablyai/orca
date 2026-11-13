import { track } from '@/diagnostics/telemetry/telemetry'

type HintAction = 'dismissed' | 'try_example' | 'agent_selected'

export type TabAgentSearchHintSession = {
  claimHint: () => Promise<boolean>
  trackAction: (action: HintAction) => void
}

export function wasTabAgentSearchHintExposed(): boolean {
  try {
    return window.localStorage.getItem('orca.tabAgentSearchHint.v1') !== null
  } catch {
    return true
  }
}

export function createTabAgentSearchHintSession(): TabAgentSearchHintSession {
  let active = false
  return {
    claimHint: async () => {
      try {
        const assignment = await window.api.telemetryClaimTabAgentSearchHint?.(
          wasTabAgentSearchHintExposed()
        )
        active = assignment === 'control' || assignment === 'treatment'
        return assignment === 'treatment'
      } catch {
        return false
      }
    },
    trackAction: (action) => {
      if (!active) {
        return
      }
      if (action === 'agent_selected') {
        active = false
      }
      track('tab_agent_search_hint_action', { action })
    }
  }
}
