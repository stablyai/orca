import { describe, expect, it, vi } from 'vitest'
import type {
  Automation,
  AutomationUpdateInput
} from '../../../../../shared/automations/automation-definition'
import type { AutomationEventTrigger } from '../../../../../shared/automation-event-triggers'
import { makeAutomation } from '../automations-page-fixtures'
import { buildAutomationEditDraft } from './automation-edit-draft'
import {
  botSectionBase,
  botSectionPatch,
  sameBotSectionBase,
  saveBotAutomationSection
} from './automation-bot-section-save'

vi.mock('@/lib/agent-catalog/agent-catalog', () => ({ getAgentCatalog: () => [] }))

// 9:00 every weekday, saved by a client in New York on a server.
const SAVED: Automation = makeAutomation({
  id: 'a1',
  name: 'Digest',
  prompt: 'Post the digest',
  rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0',
  dtstart: 1_700_000_000_000,
  timezone: 'America/New_York',
  timezoneExplicit: false,
  workspaceMode: 'existing',
  bot: { botId: 'b1', runsIn: 'new', resultsTo: 'chat' },
  on: []
})
const SLACK: AutomationEventTrigger = {
  id: 't1',
  source: 'slack',
  event: 'message',
  in: ['slack:T1:C1']
}
const GITHUB: AutomationEventTrigger = { id: 't2', source: 'github', event: 'pr_opened', in: [] }

describe('bot section patches', () => {
  it('sends only the schedule for When, never a zone', () => {
    const draft = { ...buildAutomationEditDraft(SAVED), time: '10:30' }
    const patch = botSectionPatch('when', SAVED, draft, 5)
    expect(patch).toEqual({
      rrule: expect.stringContaining('BYHOUR=10'),
      dtstart: 5
    })
    expect(patch).not.toHaveProperty('timezone')
    expect(patch).not.toHaveProperty('bot')
    expect(patch).not.toHaveProperty('prompt')
  })

  it('sends nothing for an unchanged When', () => {
    expect(botSectionPatch('when', SAVED, buildAutomationEditDraft(SAVED), 5)).toEqual({})
  })

  it('sends only the bot target for Results', () => {
    const draft = buildAutomationEditDraft(SAVED)
    draft.bot = { botId: 'b1', runsIn: 'new', resultsTo: 'none' }
    expect(botSectionPatch('results', SAVED, draft, 5)).toEqual({
      bot: { botId: 'b1', runsIn: 'new', resultsTo: 'none' }
    })
  })
})

describe('bot section base', () => {
  it('ignores key order and absent fields but not array order', () => {
    const a = botSectionBase('when', { ...SAVED, on: [SLACK, GITHUB] })
    const b = botSectionBase('when', { ...SAVED, on: [SLACK, GITHUB], timezoneExplicit: undefined })
    expect(sameBotSectionBase(a, b)).toBe(true)
    const c = botSectionBase('when', { ...SAVED, on: [GITHUB, SLACK] })
    expect(sameBotSectionBase(a, c)).toBe(false)
  })

  it('treats a changed zone as a When change', () => {
    expect(
      sameBotSectionBase(
        botSectionBase('when', SAVED),
        botSectionBase('when', { ...SAVED, timezone: 'Europe/Paris' })
      )
    ).toBe(false)
  })
})

describe('saveBotAutomationSection', () => {
  const draft = { ...buildAutomationEditDraft(SAVED), time: '10:30' }

  it('stops with the latest record when someone else changed the section', async () => {
    const latest = { ...SAVED, rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0' }
    const write = vi.fn()
    const result = await saveBotAutomationSection({
      section: 'when',
      base: botSectionBase('when', SAVED),
      draft,
      force: false,
      now: 5,
      reread: async () => latest,
      write
    })
    expect(result).toEqual({ kind: 'conflict', latest })
    expect(write).not.toHaveBeenCalled()
  })

  it('saves over a change in another section, sending only its own fields', async () => {
    const latest: Automation = {
      ...SAVED,
      prompt: 'Changed elsewhere',
      bot: { botId: 'b1', runsIn: 'new', resultsTo: 'none' }
    }
    const write = vi.fn(async (_updates: AutomationUpdateInput) => latest)
    const result = await saveBotAutomationSection({
      section: 'when',
      base: botSectionBase('when', SAVED),
      draft,
      force: false,
      now: 5,
      reread: async () => latest,
      write
    })
    expect(result.kind).toBe('saved')
    expect(Object.keys(write.mock.calls[0][0]).sort()).toEqual(['dtstart', 'rrule'])
  })

  it('writes anyway on Save mine', async () => {
    const write = vi.fn(async () => SAVED)
    await saveBotAutomationSection({
      section: 'when',
      base: botSectionBase('when', SAVED),
      draft,
      force: true,
      now: 5,
      reread: async () => ({ ...SAVED, rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0' }),
      write
    })
    expect(write).toHaveBeenCalledOnce()
  })

  it('shows the latest record when the write-time guard refuses a racing edit', async () => {
    const latest = { ...SAVED, rrule: 'FREQ=HOURLY' }
    const result = await saveBotAutomationSection({
      section: 'when',
      base: botSectionBase('when', SAVED),
      draft,
      force: true,
      now: 5,
      reread: vi.fn().mockResolvedValueOnce(SAVED).mockResolvedValueOnce(latest),
      write: async () => {
        throw new Error('automation_changed')
      }
    })
    expect(result).toEqual({ kind: 'conflict', latest })
  })
})
