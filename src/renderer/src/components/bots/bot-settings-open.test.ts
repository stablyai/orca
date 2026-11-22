import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'

const { openBotHome } = vi.hoisted(() => ({ openBotHome: vi.fn(() => true) }))
const bot: Bot = {
  id: 'bot-1',
  name: 'CoS',
  hostId: 'local',
  folder: 'cos',
  folderWorkspaceId: 'fw-cos',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}
vi.mock('@/lib/bot-catalog', () => ({ readBots: () => [bot], openBotHome }))

import { readBotSettingsPlace, setBotSettingsPlace } from './settings-view/bot-settings-place'
import { openBotSettings } from './bot-settings-open'

beforeEach(() => {
  useAppStore.setState({
    activeView: 'terminal',
    settingsNavigationTarget: null,
    rightSidebarTab: 'explorer',
    rightSidebarOpen: false
  })
  setBotSettingsPlace('panel', null)
  setBotSettingsPlace('page', null)
  openBotHome.mockClear()
  openBotHome.mockReturnValue(true)
})

describe('openBotSettings', () => {
  it('opens Memory History in the bot’s panel after switching to its page', () => {
    openBotSettings('bot-1', 'memory-history')
    expect(openBotHome).toHaveBeenCalledWith(bot)
    expect(useAppStore.getState()).toMatchObject({
      activeView: 'terminal',
      rightSidebarTab: 'bot-activity',
      rightSidebarOpen: true
    })
    expect(readBotSettingsPlace('panel')).toEqual({
      botId: 'bot-1',
      page: 'memory',
      memoryTab: 'history'
    })
    expect(readBotSettingsPlace('page')).toBeNull()
  })

  it('opens the view in Settings › Bots from Settings', () => {
    useAppStore.setState({ activeView: 'settings' })
    openBotSettings('bot-1', 'who-can-ask')
    expect(openBotHome).not.toHaveBeenCalled()
    expect(useAppStore.getState().settingsNavigationTarget).toMatchObject({
      pane: 'bots',
      sectionId: 'bot-1'
    })
    expect(readBotSettingsPlace('page')).toEqual({ botId: 'bot-1', page: 'who-can-ask' })
    expect(readBotSettingsPlace('panel')).toBeNull()
  })

  it('falls back to Settings when the bot’s page can’t open', () => {
    openBotHome.mockReturnValue(false)
    openBotSettings('bot-1')
    expect(useAppStore.getState().activeView).toBe('settings')
    expect(readBotSettingsPlace('page')).toEqual({ botId: 'bot-1', page: null })
  })
})
