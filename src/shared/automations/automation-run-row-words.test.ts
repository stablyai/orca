import { describe, expect, it } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../automation-event-triggers'
import type { AutomationRunMessage, AutomationRunMessageEvent } from './automation-run-message'
import {
  automationRunFacts,
  automationRunReason,
  sayAutomationRunEnglish,
  type AutomationRunWording,
  type SayAutomationRun
} from './automation-run-row-words'

function reused(
  event: Omit<AutomationRunMessageEvent, 'occurredAt' | 'replayed'>
): AutomationRunMessage {
  return {
    runId: 'r1',
    automation: {
      id: 'a1',
      name: 'Triage',
      enabled: true,
      nextRunAt: 0,
      updatedAt: 0,
      ...EVENT_ONLY_SCHEDULE,
      workspaceId: null
    },
    trigger: 'manual',
    event: { ...event, occurredAt: 0, replayed: true },
    instructionsLength: 0
  }
}

function wording(say: SayAutomationRun): AutomationRunWording {
  return { say, formatTime: () => '10:30', schedule: '' }
}

describe('a reused event', () => {
  it('lowercases only the event word, keeping acronyms', () => {
    const ci = reused({ source: 'github', event: 'ci_failed', place: 'Stablyai/Orca#41979' })
    expect(automationRunReason(ci, 'ran', 0, wording(sayAutomationRunEnglish))).toBe(
      'Reused CI failed · #41979'
    )
  })

  it('keeps the capitals of a leading place and of a word next to a caseless script', () => {
    const placeFirst: SayAutomationRun = (key, params) =>
      key === 'whatOn'
        ? `${params?.where} の ${params?.what}`
        : key === 'what.github.issue_opened'
          ? 'Issue 作成'
          : sayAutomationRunEnglish(key, params)
    const mention = reused({ source: 'linear', event: 'mentioned', place: 'ENG-123' })
    const issue = reused({ source: 'github', event: 'issue_opened', place: 'Stablyai/Orca#1' })
    expect(automationRunFacts(mention, 0, wording(placeFirst))).toBe(
      'Reused event: ENG-123 の mention · from 10:30'
    )
    expect(automationRunReason(issue, 'ran', 0, wording(placeFirst))).toBe('Reused Issue 作成 · #1')
  })
})
