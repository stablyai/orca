import { describe, expect, it } from 'vitest'
import type { AutomationEventTrigger } from '../../../../shared/automation-event-triggers'
import { eventTriggerLine } from '../automations/authoring/AutomationBotEventsField'

const THREAD = 'slack:T05:C0ORCA:1793590000.000100'

describe('eventTriggerLine', () => {
  it('words a Slack rule by the names saved with it', () => {
    const named: AutomationEventTrigger = {
      id: 'on-1',
      source: 'slack',
      event: 'message',
      subject: THREAD,
      from: ['U05NORA'],
      names: { [THREAD]: '#orca', U05NORA: 'Nora' }
    }
    expect(eventTriggerLine(named)).toBe('On a Slack message · in a thread in #orca · from Nora')
    expect(
      eventTriggerLine({
        id: 'on-2',
        source: 'slack',
        event: 'message',
        in: ['slack:T05:C0ORCA'],
        from: ['U05NORA'],
        names: { 'slack:T05:C0ORCA': '#orca', U05NORA: 'Nora' }
      })
    ).toBe('On a Slack message · in #orca · from Nora')
  })

  it('never shows a raw id for a rule saved before names', () => {
    expect(
      eventTriggerLine({
        id: 'on-1',
        source: 'slack',
        event: 'message',
        subject: THREAD,
        in: ['slack:T05:C0ORCA'],
        from: ['U05NORA', 'U05DANA']
      })
    ).toBe(
      'On a Slack message · in a Slack channel · in a thread in a Slack channel · from 2 people'
    )
  })

  it('names what it can and counts the rest', () => {
    expect(
      eventTriggerLine({
        id: 'on-1',
        source: 'slack',
        event: 'mentioned',
        in: ['slack:T05:C1', 'slack:T05:C2', 'slack:T05:C3'],
        from: ['U1', 'U2'],
        names: { 'slack:T05:C1': '#orca', U1: 'Nora' }
      })
    ).toBe('When you’re mentioned in Slack · in #orca and 2 more · from Nora or 1 other')
  })

  it('words the people any one of whom starts it, you among them for your own pull requests', () => {
    const pr = { id: 'on-1', source: 'github', event: 'pr_opened' } as const
    expect(eventTriggerLine({ ...pr, fromOwner: true })).toBe(
      'When a pull request is opened · from you'
    )
    expect(
      eventTriggerLine({ ...pr, fromOwner: true, from: ['300'], names: { '300': 'Dana' } })
    ).toBe('When a pull request is opened · from you or Dana')
    expect(
      eventTriggerLine({
        ...pr,
        fromOwner: true,
        from: ['200', '300'],
        names: { '200': 'Nora', '300': 'Dana' }
      })
    ).toBe('When a pull request is opened · from you, Nora, or Dana')
    expect(eventTriggerLine({ ...pr, fromOwner: true, from: ['200', '300'] })).toBe(
      'When a pull request is opened · from you or 2 others'
    )
  })

  it('words GitHub and Linear places by name, and keys written before refs as they read', () => {
    expect(
      eventTriggerLine({
        id: 'on-1',
        source: 'github',
        event: 'pr_opened',
        in: ['github:42:777'],
        names: { 'github:42:777': 'stablyai/orca' }
      })
    ).toBe('When a pull request is opened · in stablyai/orca')
    expect(
      eventTriggerLine({
        id: 'on-2',
        source: 'github',
        event: 'comment',
        subject: 'github:42:777:8'
      })
    ).toBe('On a GitHub comment · on an issue or pull request')
    expect(
      eventTriggerLine({
        id: 'on-3',
        source: 'linear',
        event: 'mentioned',
        subject: 'linear:org-1:issue-42',
        names: { 'linear:org-1:issue-42': 'ENG-42' }
      })
    ).toBe('When mentioned in Linear · on ENG-42')
    expect(
      eventTriggerLine({
        id: 'on-4',
        source: 'linear',
        event: 'assigned',
        in: ['ENG'],
        subject: 'ENG-7'
      })
    ).toBe('When assigned in Linear · in ENG · on ENG-7')
    expect(
      eventTriggerLine({
        id: 'on-5',
        source: 'linear',
        event: 'assigned',
        in: ['linear:org-1:team:t1']
      })
    ).toBe('When assigned in Linear · in a Linear team')
  })
})
