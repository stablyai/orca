// @vitest-environment happy-dom
import { createElement as h, useRef } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Bot } from '../../../../shared/bot-types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  setPendingAutomationRunNavigation: vi.fn(),
  openAutomationsPage: vi.fn(),
  setRightSidebarTab: vi.fn(),
  setRightSidebarOpen: vi.fn()
}
const bots = [
  { id: 'b1', hostId: 'local', name: 'Pixel' },
  { id: 'b1', hostId: 'runtime:env-2', name: 'Pixel on the server' }
]
const openBotHome = vi.fn((_bot: unknown) => true)
const toastMessage = vi.fn()

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/lib/bot-catalog', () => ({ openBotHome: (bot: unknown) => openBotHome(bot) }))
vi.mock('@/lib/bot-catalog-snapshot', () => ({
  readHostBots: (hostId: string) => bots.filter((bot) => bot.hostId === hostId)
}))
vi.mock('sonner', () => ({ toast: { message: (text: string) => toastMessage(text) } }))

const { openBotAutomation } = await import('./bot-automation-open')
const { BotNeedsYouSection } = await import('./BotNeedsYouSection')
const { makeAutomation } = await import('../automations/automations-page-fixtures')
const { readBotAutomationPlace, setBotAutomationPlace, useBotAutomationPlace, returnToActivity } =
  await import('./bot-automation-place')
const { readBotSettingsPlace, setBotSettingsPlace } =
  await import('./settings-view/bot-settings-place')

beforeEach(() => {
  vi.clearAllMocks()
  openBotHome.mockReturnValue(true)
  setBotAutomationPlace(null)
})

describe('openBotAutomation', () => {
  it('opens a bot surface’s automation in that bot’s panel, on the host it names', () => {
    setBotSettingsPlace('panel', { botId: 'b1', page: 'agent' })
    openBotAutomation({
      bot: { hostId: 'runtime:env-2', id: 'b1' },
      automationId: 'a1',
      runId: 'r1',
      originRowKey: 'auto:a1'
    })
    expect(openBotHome).toHaveBeenCalledWith(bots[1])
    expect(readBotAutomationPlace()).toMatchObject({
      bot: { hostId: 'runtime:env-2', id: 'b1' },
      automationId: 'a1',
      runId: 'r1',
      originRowKey: 'auto:a1'
    })
    // The panel shows one thing: the automation replaces open settings.
    expect(readBotSettingsPlace('panel')).toBeNull()
    expect(state.setRightSidebarTab).toHaveBeenCalledWith('bot-activity')
    expect(state.openAutomationsPage).not.toHaveBeenCalled()
  })

  it('keeps the page for callers with no bot, with the host they know', () => {
    openBotAutomation({ bot: null, automationId: 'a1', runId: null, hostId: 'runtime:env-2' })
    expect(state.setPendingAutomationRunNavigation).toHaveBeenCalledWith({
      automationId: 'a1',
      runId: null,
      hostId: 'runtime:env-2'
    })
    expect(state.openAutomationsPage).toHaveBeenCalled()
    expect(readBotAutomationPlace()).toBeNull()
  })

  it('opens the page when asked, still naming the bot’s host', () => {
    openBotAutomation({
      bot: { hostId: 'runtime:env-2', id: 'b1' },
      automationId: 'a1',
      runId: 'r9',
      intent: 'page'
    })
    expect(state.setPendingAutomationRunNavigation).toHaveBeenCalledWith({
      automationId: 'a1',
      runId: 'r9',
      hostId: 'runtime:env-2'
    })
    expect(openBotHome).not.toHaveBeenCalled()
  })

  it('falls back to the page, with the bot’s host, when the bot isn’t on that host', () => {
    openBotAutomation({
      bot: { hostId: 'runtime:env-9', id: 'b1' },
      automationId: 'a1',
      runId: null
    })
    expect(state.setPendingAutomationRunNavigation).toHaveBeenCalledWith({
      automationId: 'a1',
      runId: null,
      hostId: 'runtime:env-9'
    })
    expect(toastMessage).toHaveBeenCalled()
    expect(readBotAutomationPlace()).toBeNull()
  })

  it('falls back to the page when the bot’s page can’t open', () => {
    openBotHome.mockReturnValue(false)
    openBotAutomation({ bot: { hostId: 'local', id: 'b1' }, automationId: 'a1', runId: null })
    expect(state.openAutomationsPage).toHaveBeenCalled()
    expect(readBotAutomationPlace()).toBeNull()
  })

  it('never maps an SSH bot to this computer', () => {
    openBotAutomation({ bot: { hostId: 'ssh:box', id: 'b1' }, automationId: 'a1', runId: null })
    expect(openBotHome).not.toHaveBeenCalled()
    expect(state.openAutomationsPage).toHaveBeenCalled()
  })
})

afterEach(cleanup)

it('Back restores focus to the originating row and its scroll position', async () => {
  const bot: Bot = {
    ...bots[0],
    hostId: 'local',
    folderWorkspaceId: 'home',
    chatSessionId: null,
    folder: 'pixel',
    agent: 'claude',
    avatar: 'mascot:Q1',
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    github: null,
    linear: null,
    createdAt: 1,
    updatedAt: 1
  }
  const automation = makeAutomation({ id: 'a-return', name: 'Return target' })
  function Harness() {
    const panel = useRef<HTMLDivElement>(null)
    const place = useBotAutomationPlace(bot)
    if (place) {
      return h(
        'div',
        { ref: panel },
        h('button', { onClick: () => returnToActivity(panel.current, place, 'origin') }, 'Back')
      )
    }
    return h(
      'div',
      { ref: panel },
      h(
        'div',
        { 'data-bot-activity-scroller': '', tabIndex: -1 },
        h(BotNeedsYouSection, {
          bot,
          asks: {
            needs: [],
            stoppedForSignIn: [
              {
                key: 'a-return',
                automation,
                failing: true,
                latestRunId: 'r-return',
                hostId: 'local'
              }
            ],
            itemOf: () => null
          }
        })
      )
    )
  }
  render(h(TooltipProvider, null, h(Harness)))
  const scroller = document.querySelector<HTMLElement>('[data-bot-activity-scroller]')!
  scroller.scrollTop = 137
  const row = screen.getByRole('button', { name: /Return target/ })
  row.focus()
  fireEvent.click(row)
  const back = await screen.findByRole('button', { name: 'Back' })
  back.focus()
  fireEvent.click(back)
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Return target/ }))
  )
  expect(document.querySelector<HTMLElement>('[data-bot-activity-scroller]')?.scrollTop).toBe(137)
})
