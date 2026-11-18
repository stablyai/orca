import { describe, expect, it } from 'vitest'
import { getAutomationTargetAvailability } from '../hosts/automation-target-availability'
import { makeAutomation } from '../automations-page-fixtures'

const bot = { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' } as const

describe('bot automation target', () => {
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
