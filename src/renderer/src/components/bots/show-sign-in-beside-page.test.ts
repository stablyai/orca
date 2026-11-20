// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'

const mocks = vi.hoisted(() => ({ openBotConnectorsTab: vi.fn(() => true) }))
vi.mock('./bot-settings-open', () => ({ openBotConnectorsTab: mocks.openBotConnectorsTab }))

import { showSignInBesidePage } from './BotConnectorsHostNotice'
import { useAppStore } from '@/store'

const BOT = {
  id: 'bot-1',
  hostId: 'runtime:env-1',
  folderWorkspaceId: 'ws-1'
} as Bot

beforeEach(() => {
  mocks.openBotConnectorsTab.mockClear()
})

describe('showSignInBesidePage', () => {
  it('opens the Connectors tab when a chat starts the server sign-in', () => {
    useAppStore.setState({ activeView: 'terminal' })
    showSignInBesidePage(BOT.hostId, BOT)
    expect(mocks.openBotConnectorsTab).toHaveBeenCalledWith(BOT)
  })

  it('opens the Connectors tab from Settings too', () => {
    useAppStore.setState({ activeView: 'settings' })
    showSignInBesidePage(BOT.hostId, BOT)
    expect(mocks.openBotConnectorsTab).toHaveBeenCalledWith(BOT)
  })
})
