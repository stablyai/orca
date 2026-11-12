import { describe, expect, it } from 'vitest'
import { getActivityThreadTaskTitle } from './activity-thread-display'

const resumedTab = {
  customTitle: null,
  aiVaultTitle: {
    agent: 'claude' as const,
    sessionId: 'session-1',
    title: 'Triage lead handover',
    kind: 'named' as const
  },
  generatedTitle: 'Mac restarted at 15 01 so this tab stopped',
  title: 'Triage lead handover',
  defaultTitle: 'Terminal 2'
}

const resumedEntry = {
  prompt: 'How is the rename going?',
  stateHistory: [],
  agentType: 'claude' as const,
  providerSession: { key: 'session_id' as const, id: 'session-1' }
}

describe('getActivityThreadTaskTitle', () => {
  it("names a resumed session by its own name, not the tab's first prompt", () => {
    expect(
      getActivityThreadTaskTitle({
        entry: resumedEntry,
        tab: resumedTab,
        generatedTitlesEnabled: true
      })
    ).toBe('Triage lead handover')
  })
})
