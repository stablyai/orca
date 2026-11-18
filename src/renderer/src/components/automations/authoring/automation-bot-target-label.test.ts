import { describe, expect, it } from 'vitest'
import { automationTargetLabel } from './automation-bot-target-label'
import { getAutomationTargetAvailability } from '../hosts/automation-target-availability'
import { makeAutomation } from '../automations-page-fixtures'

const bot = { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' } as const

describe('bot automation target', () => {
  it('names the bot, not a project', () => {
    const automation = makeAutomation({ bot, projectId: '' })
    expect(automationTargetLabel(automation, null, [{ id: 'bot-1', name: 'Reviewer' }])).toBe(
      'Bot · Reviewer'
    )
    expect(automationTargetLabel(automation, null, [])).toBe('Deleted bot')
    expect(automationTargetLabel(makeAutomation(), { displayName: 'orca' }, [])).toBe('orca')
  })

  it('can run now without a project', () => {
    const availability = getAutomationTargetAvailability({
      automation: makeAutomation({ bot, projectId: '' }),
      repo: null,
      workspace: null,
      projectHostSetups: [],
      sshConnectionStates: new Map()
    })
    expect(availability.canRunNow).toBe(true)
  })
})
