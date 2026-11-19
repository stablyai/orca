// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { readBotSettingsPlace, setBotSettingsPlace } from './bot-settings-place'
import { BotSettingsView } from './BotSettingsView'

const leave = vi.hoisted(() => ({ allowed: true }))
vi.mock('@/lib/bot-host-views', () => ({ useBotHostOffline: () => false }))
vi.mock('../../settings/bots/use-bot-home-file', () => ({ useBotHome: () => null }))
vi.mock('./BotComputerPage', () => ({ useBotComputerName: () => 'This Mac' }))
vi.mock('./use-bot-picture-paste', () => ({ useBotPicturePaste: () => () => {} }))
vi.mock('./BotSettingsRoot', () => ({ BotSettingsRoot: () => <p>root</p> }))
vi.mock('./BotSettingsSubpage', async () => {
  const { useBotSettingsLeaveGuard } = await import('./bot-settings-leave-guard')
  return {
    BotSettingsSubpage: () => {
      useBotSettingsLeaveGuard(async () => leave.allowed)
      return <p>subpage</p>
    }
  }
})

const bot: Bot = {
  id: 'bot-1',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'bot-builder',
  folderWorkspaceId: 'home-1',
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

function show(page: 'agent' | null): { onExit: ReturnType<typeof vi.fn> } {
  setBotSettingsPlace('panel', { botId: bot.id, page })
  const onExit = vi.fn()
  render(<BotSettingsView bot={bot} host="panel" onExit={onExit} onDeleted={() => {}} />)
  return { onExit }
}

async function click(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

describe('BotSettingsView breadcrumb', () => {
  beforeEach(() => {
    leave.allowed = true
  })
  afterEach(() => {
    cleanup()
    setBotSettingsPlace('panel', null)
  })

  it('Settings goes from a subpage to the settings root', async () => {
    const { onExit } = show('agent')
    await click('Settings')
    expect(readBotSettingsPlace('panel')).toEqual({ botId: bot.id, page: null })
    expect(onExit).not.toHaveBeenCalled()
  })

  it('the bot name leaves the view from a subpage', async () => {
    const { onExit } = show('agent')
    await click('Bot builder')
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('a subpage that refuses to leave keeps both crumbs on it', async () => {
    leave.allowed = false
    const { onExit } = show('agent')
    await click('Settings')
    await click('Bot builder')
    expect(readBotSettingsPlace('panel')).toEqual({ botId: bot.id, page: 'agent' })
    expect(onExit).not.toHaveBeenCalled()
  })
})
