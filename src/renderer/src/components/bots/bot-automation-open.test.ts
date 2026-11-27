import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { openBotAutomation, openBotAutomations } from './bot-automation-open'

const bot = { workspaceId: 'folder:fixture-bot', name: 'Fixture Bot', hostId: 'local' } as const

// No Automations page mounts here, so nothing consumes a request: the mount is held.
describe("a bot's All N automations request", () => {
  beforeEach(() => {
    useAppStore.setState({
      activeView: 'terminal',
      automationsPageBotFilterRequest: null,
      pendingAutomationRunNavigation: null
    })
  })

  it('is dropped when the page is left before it applied it, so a later open is unfiltered', () => {
    openBotAutomations(bot)
    expect(useAppStore.getState().automationsPageBotFilterRequest).toEqual(bot)
    useAppStore.getState().setActiveView('terminal')
    expect(useAppStore.getState().automationsPageBotFilterRequest).toBeNull()
    useAppStore.getState().openAutomationsPage()
    expect(useAppStore.getState().automationsPageBotFilterRequest).toBeNull()
  })

  it('is dropped by closing the page or by an ordinary open', () => {
    openBotAutomations(bot)
    useAppStore.getState().closeAutomationsPage()
    expect(useAppStore.getState().automationsPageBotFilterRequest).toBeNull()
    openBotAutomations(bot)
    useAppStore.getState().openAutomationsPage()
    expect(useAppStore.getState().automationsPageBotFilterRequest).toBeNull()
  })

  it('gives way to a later deep link, and displaces an earlier one', () => {
    openBotAutomations(bot)
    openBotAutomation('local', 'automation-1', 'run-1')
    expect(useAppStore.getState().automationsPageBotFilterRequest).toBeNull()
    expect(useAppStore.getState().pendingAutomationRunNavigation?.runId).toBe('run-1')

    openBotAutomations(bot)
    expect(useAppStore.getState().pendingAutomationRunNavigation).toBeNull()
    expect(useAppStore.getState().automationsPageBotFilterRequest).toEqual(bot)
  })
})
