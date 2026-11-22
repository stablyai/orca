import { describe, expect, it } from 'vitest'
import type { AutomationRunMessage } from './automation-run-message'
import {
  automationRunEventSourceKey,
  automationRunLabel,
  sayAutomationRunEnglish
} from './automation-run-row-words'

describe("an event run's trigger", () => {
  it('names a known source and reads anything else as Event', () => {
    expect(automationRunEventSourceKey({ source: 'webhook' })).toBe('webhook')
    expect(automationRunEventSourceKey({ source: 'jira' })).toBe('what.other')
    expect(automationRunEventSourceKey({ source: '__proto__' })).toBe('what.other')
    expect(automationRunEventSourceKey(null)).toBe('what.other')
  })

  it('reads as Event in the chat row when the run carries no event', () => {
    const run: AutomationRunMessage = {
      runId: 'run-1',
      automation: {
        id: 'auto-1',
        name: 'Triage',
        enabled: true,
        nextRunAt: 0,
        updatedAt: 1,
        dtstart: 1,
        rrule: 'FREQ=DAILY',
        workspaceId: 'folder:bot'
      },
      trigger: 'event',
      instructionsLength: 0
    }
    expect(automationRunLabel(run, sayAutomationRunEnglish)).toBe('Event')
  })
})
