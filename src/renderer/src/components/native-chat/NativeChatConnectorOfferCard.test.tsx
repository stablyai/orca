// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type * as LinkRead from '@/lib/bot-host-link-read'
import type * as RendererI18n from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { ConnectorOffer } from '../../../../shared/bots/bot-connector-offer'

type Mocks = {
  bots: Bot[]
  start: ReturnType<typeof vi.fn>
  updateBot: ReturnType<typeof vi.fn>
  /** This computer's link to Orca Cloud as its bots.list says it. */
  localConnector: string | undefined
  /** How this computer's bots.list read ends: landed, failed, or set aside (an edit was out). */
  localRead: 'lands' | 'fails' | 'set-aside'
  /** Runs while this computer's read is out, before it lands. */
  whileReading: (() => void) | null
  language: 'first' | 'second' | null
}
const mocks = vi.hoisted((): Mocks => ({
  bots: [],
  start: vi.fn(),
  updateBot: vi.fn(),
  localConnector: 'ok',
  localRead: 'lands',
  whileReading: null,
  language: null
}))
vi.mock('@/i18n/i18n', async (actual) => {
  const real = await actual<typeof RendererI18n>()
  const reasons = new Set([
    'bots.cloudSignIn.webhooksChat',
    'bots.cloudSignIn.eventsChat',
    'bots.cloudSignIn.webhooksHostChat',
    'bots.cloudSignIn.eventsHostChat',
    'bots.host.notice.notReaching'
  ])
  return {
    ...real,
    translate: (...args: Parameters<typeof real.translate>) => {
      if (!mocks.language || !reasons.has(args[0])) {
        return real.translate(...args)
      }
      if (args[0] === 'bots.host.notice.notReaching') {
        return mocks.language === 'first'
          ? 'First-language link warning'
          : 'Second-language link warning'
      }
      return mocks.language === 'first'
        ? 'First-language sign-in reason'
        : 'Second-language sign-in reason'
    }
  }
})
vi.mock('@/lib/bot-catalog', () => ({
  useBots: () => mocks.bots,
  updateBot: mocks.updateBot,
  useBotHostConnectorStatus: () => mocks.localConnector,
  // A read of the host's list, as bot-host-refresh notes it; a set-aside read notes nothing.
  refreshBotHost: async (hostId: ExecutionHostId) => {
    const link = await import('@/lib/bot-host-link-read')
    const sent = link.sendBotHostLinkRead(hostId)
    mocks.whileReading?.()
    if (mocks.localRead !== 'set-aside') {
      link.noteBotHostLinkRead(hostId, mocks.localRead === 'lands', sent)
    }
  },
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
// A paired server's own sign-in as the card reads it; its notice stands in as one line.
type ServerRead = {
  linkRead: boolean
  offline: boolean
  reading: boolean
  verified: boolean
  settled: boolean
  state: null | { kind: string }
  account: null | { state: string }
  connector: string | undefined
}
const server = vi.hoisted((): ServerRead => ({
  linkRead: true,
  offline: false,
  reading: false,
  verified: true,
  settled: true,
  state: null,
  account: null,
  connector: 'ok'
}))
vi.mock('../bots/use-bot-host-label', () => ({
  useBotHostLabel: (hostId: string) => (hostId === 'local' ? null : 'box1')
}))
vi.mock('@/lib/bot-host-status', () => ({ useBotHostVerified: () => server.verified }))
vi.mock('@/lib/bot-host-views', () => ({ useBotHostOffline: () => server.offline }))
// This computer's reads are real; a server's freshness is set per test.
vi.mock('@/lib/bot-host-link-read', async (actual) => {
  const real = await actual<typeof LinkRead>()
  return {
    ...real,
    useBotHostLinkReadSinceOpen: (...args: Parameters<typeof real.useBotHostLinkReadSinceOpen>) => {
      const link = real.useBotHostLinkReadSinceOpen(...args)
      return args[0] === 'local' ? link : { ...link, fresh: server.linkRead }
    }
  }
})
vi.mock('@/lib/bot-catalog-snapshot', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  readBotHostConnectorStatus: () => mocks.localConnector
}))
vi.mock('@/lib/bot-host-orca-account', () => ({
  useBotHostOrcaAccountSettled: () => server.settled,
  useBotHostOrcaAccountReading: () => server.reading
}))
vi.mock('../bots/BotConnectorsHostNotice', () => ({
  useServerNoticeState: () => ({
    state: server.state,
    account: server.account,
    connector: server.connector
  }),
  BotConnectorsHostNotice: () => <p>box1 notice: Sign in on box1</p>
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
import { translate } from '@/i18n/i18n'
import { TranslationScopeContext, type Translate } from '@/i18n/use-translate'

const firstLanguageTranslator: Translate = (...args) => translate(...args)
const secondLanguageTranslator: Translate = (...args) => translate(...args)
const firstLanguageScope = { t: firstLanguageTranslator, intlLocale: 'en' }
const secondLanguageScope = { t: secondLanguageTranslator, intlLocale: 'zh' }

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
  mocks.localConnector = 'ok'
  mocks.localRead = 'lands'
  mocks.whileReading = null
  mocks.language = null
})

describe('sign-in copy when the language changes', () => {
  it.each(['local-sign-in', 'local-unread', 'server-sign-in', 'server-link-down'])(
    'updates %s without replacing the offer',
    async (state) => {
      const initial = useAppStore.getState()
      const remote = state.startsWith('server')
      const down = state.endsWith('link-down')
      useAppStore.setState({
        orcaProfileAuthStatus: state === 'local-sign-in' ? ORCA_SIGNED_OUT : ORCA_CONNECTED
      })
      mocks.localRead = down ? 'lands' : 'set-aside'
      mocks.localConnector = down ? 'refused' : 'ok'
      const bot = makeTestBot({ github: {} })
      mocks.bots = [remote ? stampBotHost('runtime:server', bot) : bot]
      server.state = state === 'server-sign-in' ? { kind: 'signed-out' } : null
      server.connector = down ? 'refused' : 'ok'
      const offer: ConnectorOffer = {
        botId: 'b1',
        source: 'github',
        signIn: !down || !remote ? true : undefined
      }
      const card = <NativeChatConnectorOfferCard offer={offer} messageId="m1" fallback="fallback" />
      mocks.language = 'first'
      try {
        const view = render(
          <TranslationScopeContext.Provider value={firstLanguageScope}>
            {card}
          </TranslationScopeContext.Provider>
        )
        expect(
          await screen.findByText(
            down ? 'First-language link warning' : 'First-language sign-in reason'
          )
        ).toBeTruthy()
        mocks.language = 'second'
        view.rerender(
          <TranslationScopeContext.Provider value={secondLanguageScope}>
            {card}
          </TranslationScopeContext.Provider>
        )
        expect(
          screen.getByText(down ? 'Second-language link warning' : 'Second-language sign-in reason')
        ).toBeTruthy()
      } finally {
        server.state = null
        server.connector = 'ok'
        useAppStore.setState(initial, true)
      }
    }
  )
})

describe('the Connect card', () => {
  it('connects through the same setup as Add connector', () => {
    show(makeTestBot({ id: 'b1' }), { source: 'linear' })
    fireEvent.click(screen.getByRole('button', { name: 'Connect Linear' }))
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
        screen.getByText(
          'Slack events need Orca Cloud sign-in. I’ll save this rule once you’re in.'
        )
      ).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
      await waitFor(() =>
        expect(chat.send).toHaveBeenCalledWith('I’m signed in to Orca Cloud now.')
      )
    } finally {
      useAppStore.setState(initial, true)
    }
  })

  describe("a paired server's bot: the server's own sign-in, never this computer's", () => {
    const serverBot = () =>
      stampBotHost('runtime:server', makeTestBot({ slack: { appId: 'A1', teamId: 'T1' } }))
    const showServer = (offer: { source: 'slack' | 'webhook' } = { source: 'slack' }) => {
      mocks.bots = [serverBot()]
      render(
        <NativeChatBotKickoffContext.Provider value={chatView}>
          <NativeChatConnectorOfferCard
            offer={{ botId: 'b1', ...offer, signIn: true }}
            messageId="m1"
            fallback="the server's own line"
          />
        </NativeChatBotKickoffContext.Provider>
      )
    }
    afterEach(() => {
      Object.assign(server, {
        linkRead: true,
        offline: false,
        reading: false,
        verified: true,
        settled: true,
        state: null,
        account: null,
        connector: 'ok'
      })
    })

    it('asks for the server signed in, with its notice and Sign in on the server', () => {
      server.state = { kind: 'signed-out' }
      server.account = { state: 'signed-out' }
      showServer()
      expect(
        screen.getByText(
          'Slack events need box1 signed in to Orca Cloud. I’ll save this rule once it is.'
        )
      ).toBeTruthy()
      expect(screen.getByText('box1 notice: Sign in on box1')).toBeTruthy()
      expect(screen.queryByText('Signed in to Orca')).toBeNull()
    })

    it('says webhooks wait on the server', () => {
      server.state = { kind: 'signed-out' }
      showServer({ source: 'webhook' })
      expect(
        screen.getByText('Webhooks need box1 signed in to Orca Cloud. I’ll make it once it is.')
      ).toBeTruthy()
    })

    it('reads Signed in only once the verified server is signed in and Orca Cloud takes it', () => {
      server.account = { state: 'signed-in' }
      showServer()
      expect(screen.getByText('Signed in to Orca')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
    })

    it.each([
      ['unverified', { verified: false }],
      ['offline, showing its last read', { offline: true }],
      ['a fresh read is still under way', { reading: true }],
      ['its link to Orca Cloud has not been read since the card opened', { linkRead: false }],
      ['its link to Orca Cloud is unknown', { connector: undefined }],
      ['its link to Orca Cloud says signed out', { connector: 'signed-out' }],
      ['unread', { settled: false }],
      ['unknown account', { account: null }],
      ['refused by Orca Cloud', { connector: 'refused' }],
      ['a sign-in Orca Cloud refuses', { connector: 'needs-sign-in' }]
    ])('keeps the server line, never Signed in, when %s', (_case, change) => {
      Object.assign(server, { account: { state: 'signed-in' } }, change)
      showServer()
      expect(screen.getByText("the server's own line")).toBeTruthy()
      expect(screen.queryByText('Signed in to Orca')).toBeNull()
      expect(screen.queryByRole('button')).toBeNull()
    })
  })
})

describe('a connected card whose host is not signed in to Orca Cloud', () => {
  afterEach(() => {
    server.state = null
    server.connector = 'ok'
  })

  it.each(['refused', 'signed-out', 'needs-sign-in', 'unreachable'])(
    'reads Paused when the server link is %s with no notice of its own',
    (connector) => {
      server.connector = connector
      show(stampBotHost('runtime:server', makeTestBot({ github: {} })), { source: 'github' })
      expect(screen.getByText('Paused')).toBeTruthy()
      expect(screen.getByText('Slack, Linear and GitHub aren’t reaching Scout.')).toBeTruthy()
    }
  )

  it("reads Paused with the server's notice, never Connected", () => {
    server.state = { kind: 'signed-out' }
    show(stampBotHost('runtime:server', makeTestBot({ github: {} })), { source: 'github' })
    expect(screen.getByText('Paused')).toBeTruthy()
    expect(screen.queryByText('Connected')).toBeNull()
    expect(screen.getByText('box1 notice: Sign in on box1')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add repositories or organizations' })).toBeTruthy()
  })

  it("stays Connected when the server only needs an update, which doesn't stop its events", () => {
    server.state = { kind: 'update-needed' }
    show(stampBotHost('runtime:server', makeTestBot({ github: {} })), { source: 'github' })
    expect(screen.getAllByText('Connected').length).toBeGreaterThan(0)
    expect(screen.queryByText('Paused')).toBeNull()
  })

  it('reads Paused with Sign in for this computer while it is signed out', () => {
    const initial = useAppStore.getState()
    useAppStore.setState({ orcaProfileAuthStatus: ORCA_SIGNED_OUT })
    try {
      show(makeTestBot({ github: {} }), { source: 'github' })
      expect(screen.getByText('Paused')).toBeTruthy()
      expect(
        screen.getByText('GitHub connects through Orca Cloud. Sign in to Orca to continue.')
      ).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
    } finally {
      useAppStore.setState(initial, true)
    }
  })
})

describe("this computer's sign-in that Orca Cloud refuses", () => {
  afterEach(() => {
    mocks.localConnector = 'ok'
  })

  it('asks to sign in again, never Signed in, though this computer has a sign-in', () => {
    mocks.localConnector = 'needs-sign-in'
    mocks.bots = [makeTestBot({ slack: { appId: 'A1', teamId: 'T1' } })]
    render(
      <NativeChatBotKickoffContext.Provider value={chatView}>
        <NativeChatConnectorOfferCard
          offer={{ botId: 'b1', source: 'slack', signIn: true }}
          messageId="m1"
          fallback="fallback line"
        />
      </NativeChatBotKickoffContext.Provider>
    )
    expect(screen.queryByText('Signed in to Orca')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('reads Paused on a connected card', () => {
    mocks.localConnector = 'needs-sign-in'
    show(makeTestBot({ github: {} }), { source: 'github' })
    expect(screen.getByText('Paused')).toBeTruthy()
  })
})

describe('signing this computer in again from the chat', () => {
  afterEach(() => {
    mocks.localConnector = 'ok'
  })

  it("tells the bot only once Orca Cloud takes this computer's sign-in", async () => {
    const initial = useAppStore.getState()
    const connect = vi.fn(orcaSignIn())
    useAppStore.setState({
      orcaProfileAuthStatus: ORCA_SIGNED_OUT,
      connectCurrentOrcaProfile: connect
    })
    chat.send.mockClear()
    mocks.localConnector = 'needs-sign-in'
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
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
      await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
      // The sign-in and the re-read of this computer's link both settle before the check.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(chat.send).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
    } finally {
      useAppStore.setState(initial, true)
    }
  })
})

describe("this computer's Sign in card, signed in", () => {
  const showSignIn = () => {
    mocks.bots = [makeTestBot({ slack: { appId: 'A1', teamId: 'T1' } })]
    render(
      <NativeChatBotKickoffContext.Provider value={chatView}>
        <NativeChatConnectorOfferCard
          offer={{ botId: 'b1', source: 'slack', signIn: true }}
          messageId="m1"
          fallback="fallback line"
        />
      </NativeChatBotKickoffContext.Provider>
    )
  }

  it('offers Continue once a read since the card opened says the link is ok', async () => {
    showSignIn()
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeTruthy()
  })

  it('offers no Continue while the link is refused or can’t reach Orca Cloud, and says so', async () => {
    for (const connector of ['refused', 'unreachable']) {
      mocks.localConnector = connector
      showSignIn()
      expect(
        await screen.findByText('Slack, Linear and GitHub aren’t reaching Scout.')
      ).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
      expect(screen.queryByText('Signed in to Orca')).toBeNull()
      cleanup()
    }
  })

  it('offers no Continue for a kept ok that no read since the card opened confirmed', async () => {
    for (const read of ['fails', 'set-aside'] as const) {
      mocks.localRead = read
      showSignIn()
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
      expect(
        screen.getByText(
          'Slack events need Orca Cloud sign-in. I’ll save this rule once you’re in.'
        )
      ).toBeTruthy()
      cleanup()
    }
  })

  it('offers no Continue with no link to Orca Cloud at all', async () => {
    mocks.localConnector = undefined
    showSignIn()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })
})

describe('signing this computer in from the chat while its kept link reads ok', () => {
  it('tells the bot nothing when the read after the sign-in fails or is set aside', async () => {
    for (const read of ['fails', 'set-aside'] as const) {
      const initial = useAppStore.getState()
      const connect = vi.fn(orcaSignIn())
      useAppStore.setState({
        orcaProfileAuthStatus: ORCA_SIGNED_OUT,
        connectCurrentOrcaProfile: connect
      })
      chat.send.mockClear()
      mocks.localRead = read
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
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
        await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
        expect(chat.send).not.toHaveBeenCalled()
      } finally {
        useAppStore.setState(initial, true)
        cleanup()
      }
    }
  })
})

describe("this computer's Sign in card when its sign-in changes after a read said ok", () => {
  const as = (userId: string) => ({
    ...ORCA_CONNECTED,
    cloud: { cloudProfileId: `c-${userId}`, userId, email: `${userId}@example.com`, linkedAt: 1 }
  })

  it('takes Continue away until a read sent since the change says ok', async () => {
    const initial = useAppStore.getState()
    useAppStore.setState({ orcaProfileAuthStatus: as('u1') })
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
      expect(await screen.findByRole('button', { name: 'Continue' })).toBeTruthy()

      // Another account signs in; the read that follows is set aside (an edit was out).
      mocks.localRead = 'set-aside'
      act(() => useAppStore.setState({ orcaProfileAuthStatus: as('u2') }))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()

      // The next sign-in change reads again, and this read lands ok.
      mocks.localRead = 'lands'
      act(() => useAppStore.setState({ orcaProfileAuthStatus: as('u3') }))
      expect(await screen.findByRole('button', { name: 'Continue' })).toBeTruthy()
    } finally {
      useAppStore.setState(initial, true)
    }
  })

  it('says a webhook offer’s link is down in terms of webhooks, not Slack, Linear and GitHub', async () => {
    mocks.localConnector = 'refused'
    mocks.bots = [makeTestBot({})]
    render(
      <NativeChatBotKickoffContext.Provider value={chatView}>
        <NativeChatConnectorOfferCard
          offer={{ botId: 'b1', source: 'webhook' }}
          messageId="m1"
          fallback="fallback line"
        />
      </NativeChatBotKickoffContext.Provider>
    )
    expect(
      await screen.findByText('Orca Cloud isn’t reaching Scout, so it can’t make webhooks yet.')
    ).toBeTruthy()
    expect(screen.queryByText(/Slack, Linear and GitHub/)).toBeNull()
  })
})

describe('signing this computer in from the chat while its sign-in changes again', () => {
  it('does not claim an automatic reply for another account after the sign-in read', async () => {
    const signedInAs = (userId: string) => ({
      ...ORCA_CONNECTED,
      cloud: { cloudProfileId: `c-${userId}`, userId, email: `${userId}@example.com`, linkedAt: 1 }
    })
    const initial = useAppStore.getState()
    const update = mocks.updateBot.getMockImplementation()
    const claims: (string | undefined)[] = []
    mocks.updateBot.mockImplementation(async () => {
      claims.push(useAppStore.getState().orcaProfileAuthStatus?.cloud?.userId)
    })
    const connect = vi.fn(async () => {
      useAppStore.setState({ orcaProfileAuthStatus: signedInAs('u1') })
      return {
        status: 'connected' as const,
        auth: signedInAs('u1'),
        activeProfileId: 'p1',
        profiles: []
      }
    })
    useAppStore.setState({
      orcaProfileAuthStatus: ORCA_SIGNED_OUT,
      connectCurrentOrcaProfile: connect
    })
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
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      mocks.whileReading = () => {
        mocks.whileReading = null
        queueMicrotask(() =>
          queueMicrotask(() => useAppStore.setState({ orcaProfileAuthStatus: signedInAs('u2') }))
        )
      }
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
      await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(claims).toEqual(['u1'])
    } finally {
      if (update) {
        mocks.updateBot.mockImplementation(update)
      } else {
        mocks.updateBot.mockReset()
      }
      mocks.whileReading = null
      useAppStore.setState(initial, true)
    }
  })

  it('tells the bot nothing when it signs out, another account signs in, or it signs out and back in, before the read lands', async () => {
    const signedInAs = (userId: string) => ({
      ...ORCA_CONNECTED,
      cloud: { cloudProfileId: `c-${userId}`, userId, email: `${userId}@example.com`, linkedAt: 1 }
    })
    // Each change runs while the read is out; the last signs out and back into the same account.
    const changes: (() => void)[] = [
      () => useAppStore.setState({ orcaProfileAuthStatus: ORCA_SIGNED_OUT }),
      () => useAppStore.setState({ orcaProfileAuthStatus: signedInAs('u2') }),
      () => {
        useAppStore.setState({ orcaProfileAuthStatus: ORCA_SIGNED_OUT })
        useAppStore.setState({ orcaProfileAuthStatus: signedInAs('u1') })
      }
    ]
    for (const change of changes) {
      const initial = useAppStore.getState()
      const connect = vi.fn(async () => {
        useAppStore.setState({ orcaProfileAuthStatus: signedInAs('u1') })
        return {
          status: 'connected' as const,
          auth: signedInAs('u1'),
          activeProfileId: 'p1',
          profiles: []
        }
      })
      useAppStore.setState({
        orcaProfileAuthStatus: ORCA_SIGNED_OUT,
        connectCurrentOrcaProfile: connect
      })
      chat.send.mockClear()
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
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
        // The read the sign-in starts lands ok, but only after the sign-in changed again.
        mocks.whileReading = change
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
        await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
        expect(chat.send).not.toHaveBeenCalled()
      } finally {
        mocks.whileReading = null
        useAppStore.setState(initial, true)
        cleanup()
      }
    }
  })
})
