// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'

const mocks = vi.hoisted(() => ({ bots: new Array<Bot>(), start: vi.fn(), updateBot: vi.fn() }))
vi.mock('@/lib/bot-catalog', () => ({
  useBots: () => mocks.bots,
  updateBot: mocks.updateBot,
  useCardBot: (id: string) => ({
    bot: mocks.bots.find((bot: { id: string }) => bot.id === id) ?? null,
    ref: { hostId: 'local', id }
  })
}))
vi.mock('@/lib/bot-slack-state', () => ({
  useBotSlack: () => ({ status: 'loading' }),
  slackTeamState: () => ({ state: 'not_created' })
}))
vi.mock('@/lib/bot-github-state', () => ({ useBotGitHub: () => ({ status: 'loading' }) }))
vi.mock('../bots/ConnectorSetupDialogs', () => ({
  useConnectorSetup: () => ({ start: mocks.start, dialogs: null })
}))

import { useAppStore } from '@/store'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import {
  chatTakingSends,
  ORCA_CONNECTED,
  ORCA_SIGNED_OUT,
  orcaSignIn
} from '../bots/orca-sign-in.test-fixture'
import { NativeChatBotKickoffContext } from './native-chat-bot-kickoff-view'
import { NativeChatConnectorOfferCard } from './NativeChatConnectorOfferCard'

const acme = { workspaceId: 'w1', workspaceName: 'Acme' }

function makeTestBot(overrides: Partial<Bot>): Bot {
  return {
    id: 'b1',
    name: 'Scout',
    hostId: 'local',
    folder: 'scout',
    folderWorkspaceId: 'scout-home',
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
    updatedAt: 1,
    ...overrides
  }
}

function show(bot: Bot, offer: { source: 'slack' | 'linear' | 'github'; workspace?: string }) {
  mocks.bots = [bot]
  render(
    <NativeChatConnectorOfferCard
      offer={{ botId: bot.id, ...offer }}
      messageId="m1"
      fallback="fallback line"
    />
  )
}

afterEach(() => {
  cleanup()
  mocks.start.mockClear()
})

describe('the Connect card', () => {
  it('connects through the same setup as Add connector', () => {
    show(makeTestBot({ id: 'b1' }), { source: 'linear' })
    expect(
      screen.getByText(
        'Hand the bot issues by @mentioning or assigning it, and start automations on Linear events.'
      )
    ).toBeTruthy()
    // How it can work there without the connector.
    expect(
      screen.getByText(
        'It can also work in Linear as you, through your own Linear sign-in in Orca.'
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(mocks.start).toHaveBeenCalledWith('linear')
  })

  it('reads Connected however it got connected, and adds another workspace from there', () => {
    show(makeTestBot({ id: 'b1', linear: acme, linearWorkspaces: [acme] }), { source: 'linear' })
    expect(screen.getByText('Connected in Acme')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add another workspace' }))
    expect(mocks.start).toHaveBeenCalledWith('linear')
  })

  it('still adds repositories or organizations once GitHub is connected', () => {
    show(makeTestBot({ id: 'b1', github: {} }), { source: 'github' })
    expect(screen.getAllByText('Connected')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Add repositories or organizations' }))
    expect(mocks.start).toHaveBeenCalledWith('github')
  })

  it('adds a named workspace the bot is not in', () => {
    show(makeTestBot({ id: 'b1', linear: acme, linearWorkspaces: [acme] }), {
      source: 'linear',
      workspace: 'Globex'
    })
    expect(screen.getByRole('button', { name: 'Add workspace' })).toBeTruthy()
  })

  it('shows the host line for a bot this window does not list', () => {
    mocks.bots = []
    render(
      <NativeChatConnectorOfferCard
        offer={{ botId: 'gone', source: 'slack' }}
        messageId="m1"
        fallback="fallback line"
      />
    )
    expect(screen.getByText('fallback line')).toBeTruthy()
  })
})

const chat = { send: vi.fn(async () => true) }
const chatView = chatTakingSends(chat.send)

describe('the Sign in card for a host signed out of Orca', () => {
  it('signs in from the chat and tells the bot, which then saves what it held', async () => {
    const initial = useAppStore.getState()
    useAppStore.setState({
      orcaProfileAuthStatus: ORCA_SIGNED_OUT,
      connectCurrentOrcaProfile: orcaSignIn()
    })
    chat.send.mockClear()
    mocks.updateBot.mockResolvedValue(undefined)
    mocks.bots = [makeTestBot({ slack: { appId: 'A1', teamId: 'T1' } })]
    try {
      render(
        <NativeChatBotKickoffContext.Provider value={chatView}>
          <NativeChatConnectorOfferCard
            offer={{ botId: 'b1', source: 'slack', signIn: true }}
            messageId="m1"
            fallback="fallback line"
          />
        </NativeChatBotKickoffContext.Provider>
      )
      expect(
        screen.getByText('Slack events need Orca sign-in. I’ll save this rule once you’re in.')
      ).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
      await waitFor(() => expect(chat.send).toHaveBeenCalledWith('I’m signed in to Orca now.'))
    } finally {
      useAppStore.setState(initial, true)
    }
  })

  it("leaves a paired server's sign-in to the server: its line, no check and no Continue", () => {
    const initial = useAppStore.getState()
    useAppStore.setState({ orcaProfileAuthStatus: ORCA_CONNECTED })
    mocks.bots = [
      stampBotHost('runtime:server', makeTestBot({ slack: { appId: 'A1', teamId: 'T1' } }))
    ]
    try {
      render(
        <NativeChatBotKickoffContext.Provider value={chatView}>
          <NativeChatConnectorOfferCard
            offer={{ botId: 'b1', source: 'slack', signIn: true }}
            messageId="m1"
            fallback="Slack events need Orca sign-in. Sign in to Orca on your computer, then tell Scout."
          />
        </NativeChatBotKickoffContext.Provider>
      )
      expect(
        screen.getByText(
          'Slack events need Orca sign-in. Sign in to Orca on your computer, then tell Scout.'
        )
      ).toBeTruthy()
      expect(screen.queryByText('Signed in to Orca')).toBeNull()
      expect(screen.queryByRole('button')).toBeNull()
    } finally {
      useAppStore.setState(initial, true)
    }
  })
})
