// @vitest-environment happy-dom

import { withBotConnectorRuntime } from '../../../lib/bot-connector-host-calls.test-fixture'
import '@testing-library/jest-dom/vitest'
import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorBotSlackStateResponse } from '../../../../../shared/connector-bot-slack-contract'
import { useAppStore } from '@/store'
import { ORCA_SIGNED_OUT, orcaSignIn } from '@/components/bots/orca-sign-in.test-fixture'
import { botConnectorRowKey, openBotConnectorPage } from '@/components/bots/bot-connector-page'
import { refreshGoogle } from '@/components/bots/google/google-connect-client'
import BotConnectorsPanel from '@/components/bots/BotConnectorsPanel'
import { publishBots, readHostBots } from '@/lib/bot-catalog-snapshot'
import { BotConnectorsSection } from './BotConnectorsSection'

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    name: 'Scout',
    hostId: 'local',
    folder: 'scout',
    folderWorkspaceId: 'fw-1',
    agent: 'codex',
    avatar: null,
    paused: false,
    permissionMode: 'ask',
    notifications: {
      needsPermission: true,
      taskComplete: true,
      couldNotFinish: true
    },
    members: [
      { id: 'U-sam', name: 'Sam Lee' },
      { id: 'D-cy', name: 'Cy on Discord', source: 'discord' }
    ],
    slack: { appId: 'A1', teamId: 'T05' },
    chatSessionId: null,
    linear: null,
    github: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

const confirm = vi.fn()

const linearState = {
  ok: true,
  value: {
    workspaces: [
      {
        workspaceId: 'org-1',
        name: 'Acme',
        urlKey: 'acme',
        installed: true,
        userId: 'L-me',
        userName: 'Dana',
        defaultBotId: null
      }
    ],
    installUrl: 'https://connector.example/linear/install'
  }
}

const gitHubOff = { ok: false, error: 'github_off' }
const gitHubOn = {
  ok: true,
  value: {
    installUrl: 'https://connector.example/github/install?state=s',
    account: { userId: '42', login: 'dana' },
    installations: [
      {
        installationId: '7',
        accountLogin: 'acme',
        repositories: [{ fullName: 'acme/web' }, { fullName: 'acme/api' }]
      }
    ],
    defaultBotId: null
  }
}

// The Slack state read, for counting reads; renderWith answers it.
const slackState = vi.fn()

function withProviders(content: ReactElement): ReactElement {
  return (
    <ConfirmationDialogContext.Provider value={confirm}>
      <TooltipProvider>{content}</TooltipProvider>
    </ConfirmationDialogContext.Provider>
  )
}

/** Renders the section; the returned call shows another bot in the same, still mounted, section. */
function renderWith(
  subject: Bot,
  slack: ConnectorBotSlackStateResponse,
  github: unknown = gitHubOff,
  googleStatus?: () => unknown
): (next: Bot) => void {
  Object.assign(window, {
    api: withBotConnectorRuntime({
      runtime: {
        call: ({ method }) =>
          method === 'google.status' && googleStatus
            ? { ok: true, result: googleStatus() }
            : undefined
      },
      botSlack: {
        state: slackState.mockResolvedValue({ ok: true, value: slack })
      },
      botLinear: { state: vi.fn().mockResolvedValue(linearState) },
      botGitHub: { state: vi.fn().mockResolvedValue(github) }
    })
  })
  const { rerender } = render(withProviders(<BotConnectorsSection bot={subject} />))
  return (next) => rerender(withProviders(<BotConnectorsSection bot={next} />))
}

afterEach(() => {
  cleanup()
  // Each test is a new session: no row remembers how an earlier one left it.
  openBotConnectorPage(null)
  slackState.mockReset()
  Reflect.deleteProperty(window, 'api')
})

// How to ask sets the text to type as code, so the sentence spans several nodes.
const sentence =
  (text: string) =>
  (_: string, element: Element | null): boolean =>
    element?.tagName === 'P' && element.textContent === text

describe('BotConnectorsSection', () => {
  it('gives a Slack workspace a row named for it, with no status while well, and its own Who can ask', async () => {
    renderWith(bot({ name: '<b>Scout</b> & co' }), {
      state: 'installed',
      teamId: 'T05',
      teamName: 'Globex',
      appId: 'A1',
      botUserId: 'UB',
      installerUserId: 'U07'
    })
    expect(await screen.findByText('installed by U07')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Slack · Globex' })).toBeDefined()
    expect(screen.queryByText('Connected')).toBeNull()
    expect(screen.getByText('You')).toBeDefined()
    expect(screen.getByText('Sam Lee')).toBeDefined()
    // Another service's people belong on that service's card.
    expect(screen.queryByText('Cy on Discord')).toBeNull()
    const mention = screen.getByText('@<b>Scout</b> & co')
    expect(mention.tagName).toBe('CODE')
    expect(mention.querySelector('b')).toBeNull()
  })

  it('says once, signed out, what is off and offers Sign in, which reads the connectors again', async () => {
    const initial = useAppStore.getState()
    useAppStore.setState({
      orcaProfileAuthStatus: ORCA_SIGNED_OUT,
      connectCurrentOrcaProfile: orcaSignIn()
    })
    try {
      renderWith(bot({ id: 'bot-hint' }), {
        state: 'installed',
        teamId: 'T05',
        teamName: 'Globex',
        appId: 'A1',
        botUserId: 'UB',
        installerUserId: 'U07'
      })
      const state = slackState
      expect(screen.getByText(/Signed out of Orca · Slack, events, sharing off/)).toBeDefined()
      await waitFor(() => expect(state).toHaveBeenCalled())
      const reads = state.mock.calls.length
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
      await waitFor(() => expect(screen.queryByText(/Signed out of Orca/)).toBeNull())
      expect(state.mock.calls.length).toBeGreaterThan(reads)
    } finally {
      useAppStore.setState(initial, true)
    }
  })

  it('offers Add a connector without rows for unused Slack or GitHub', async () => {
    renderWith(bot({ slack: null, members: [] }), { state: 'not_created' }, gitHubOn)
    await screen.findByRole('button', { name: /Add a connector/ })
    expect(screen.queryByRole('button', { name: /^Slack(?: ·|$)/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^GitHub(?: ·|$)/ })).toBeNull()
  })

  it('gives Linear its own row, with its handle and its own people', async () => {
    renderWith(
      bot({
        slack: null,
        linear: { workspaceId: 'org-1', workspaceName: 'Acme' },
        members: [
          { id: 'U-sam', name: 'Sam Lee' },
          {
            id: 'L-bea',
            name: 'Bea on Linear',
            source: 'linear',
            workspaceId: 'org-1'
          }
        ]
      }),
      { state: 'not_created' }
    )
    // A bot saved without the address shows the one the cloud reports.
    expect(await screen.findByText('linear.app/acme')).toBeDefined()
    expect(
      screen.getByText(sentence('Mention @Orca scout on an issue, or add the label bot:scout.'))
    ).toBeDefined()
    expect(screen.getByText('bot:scout').tagName).toBe('CODE')
    // Each row lists only its own service's people.
    const cards = screen.getAllByText('Who can ask Scout')
    expect(cards).toHaveLength(2)
    expect(screen.getAllByText('Bea on Linear')).toHaveLength(1)
    expect(screen.getAllByText('Sam Lee')).toHaveLength(1)
    expect(screen.getByText('Everyone else in Acme gets a public reply to ask you.')).toBeDefined()
  })

  it('gives a bot on GitHub its own row, with how to ask and its own people', async () => {
    renderWith(
      bot({
        slack: null,
        github: {},
        members: [
          { id: 'U-sam', name: 'Sam Lee' },
          { id: '583231', name: 'octocat', source: 'github' }
        ]
      }),
      { state: 'not_created' },
      gitHubOn
    )
    expect(await screen.findByText('web, api · signed in as @dana')).toBeDefined()
    expect(screen.getByRole('button', { name: 'GitHub · acme' })).toBeDefined()
    expect(
      screen.getByText(sentence('Mention @orca-bots scout … on an issue or pull request.'))
    ).toBeDefined()
    // Each row lists only its own service's people.
    expect(screen.getAllByText('octocat')).toHaveLength(1)
    expect(screen.getAllByText('Sam Lee')).toHaveLength(1)
    // Two connectors (Sam stays listed under Slack), so each row starts closed.
    fireEvent.click(screen.getByRole('button', { name: 'GitHub · acme' }))
    const addButtons = screen.getAllByRole('button', { name: 'Add' })
    expect(addButtons.at(-1)?.hasAttribute('disabled')).toBe(false)
    expect(
      screen.getByText('Everyone else on GitHub gets a public reply to ask you.')
    ).toBeDefined()
  })

  it('gives each workspace and org its own row, leaving out a removed org', async () => {
    renderWith(
      bot({
        slackApps: [
          { appId: 'A1', teamId: 'T05' },
          { appId: 'A2', teamId: 'T06' }
        ],
        linearWorkspaces: [
          { workspaceId: 'org-1', workspaceName: 'Acme' },
          { workspaceId: 'org-2', workspaceName: 'Beta', urlKey: 'beta' }
        ],
        github: { removedInstallationIds: ['8'] }
      }),
      {
        state: 'installed',
        teamId: 'T05',
        teamName: 'Globex',
        appId: 'A1',
        botUserId: 'UB',
        installerUserId: 'U07',
        teams: [
          {
            state: 'installed',
            teamId: 'T05',
            teamName: 'Globex',
            appId: 'A1',
            botUserId: 'UB',
            installerUserId: 'U07'
          },
          { state: 'created', teamId: 'T06', appId: 'A2' }
        ]
      },
      {
        ...gitHubOn,
        value: {
          ...gitHubOn.value,
          installations: [
            ...gitHubOn.value.installations,
            {
              installationId: '8',
              accountLogin: 'old-org',
              repositories: null
            }
          ]
        }
      }
    )
    expect(await screen.findByText('installed by U07')).toBeDefined()
    // Each row is titled for its own place; the workspace not installed yet has no name to show.
    expect(
      screen
        .getAllByRole('button')
        .map((button) => button.textContent)
        .filter((text) => /^(Slack|Linear|GitHub)/.test(text ?? ''))
    ).toEqual(['Slack · Globex', 'Slack', 'Linear · Acme', 'Linear · Beta', 'GitHub · acme'])
    // The workspace waiting on its install and Beta, not linked yet, each say what they need.
    expect(await screen.findAllByText('Finish setup')).toHaveLength(2)
    expect(screen.getAllByText(/link your Linear account in Beta/).length).toBeGreaterThan(0)
    expect(await screen.findByText('web, api · signed in as @dana')).toBeDefined()
    expect(screen.queryByText(/old-org/)).toBeNull()
  })
})

const installedSlack: ConnectorBotSlackStateResponse = {
  state: 'installed',
  teamId: 'T05',
  teamName: 'Globex',
  appId: 'A1',
  botUserId: 'UB',
  installerUserId: 'U07'
}

describe('BotConnectorsSection pages', () => {
  it('opens the requested app when switching from a bot with different tools', async () => {
    const first = bot({ id: 'first', folderWorkspaceId: 'first-home' })
    const second = bot({ id: 'second', folderWorkspaceId: 'second-home' })
    const previousBots = readHostBots('local')
    const previousWorkspace = useAppStore.getState().activeWorktreeId
    publishBots([first, second])
    useAppStore.setState({ activeWorktreeId: 'folder:first-home' })
    Object.assign(window, {
      api: {
        runtime: {
          call: ({ method, params }: { method: string; params?: { botId: string } }) => {
            if (method === 'bots.list') {
              return { ok: true, result: { bots: [first, second] } }
            }
            if (method === 'bots.tools.list') {
              const name = params?.botId === second.id ? 'docs' : 'reports'
              return {
                ok: true,
                result: {
                  own: [{ name, remote: true, detail: 'https://example.test/mcp' }],
                  inherited: []
                }
              }
            }
            return { ok: false, error: { code: 'unavailable', message: method } }
          }
        }
      }
    })
    try {
      render(withProviders(<BotConnectorsPanel />))
      await screen.findByRole('button', { name: 'Reports' })
      act(() => {
        openBotConnectorPage(botConnectorRowKey(second, 'app:docs'))
        useAppStore.setState({ activeWorktreeId: 'folder:second-home' })
      })
      expect(await screen.findByRole('heading', { name: 'Docs' })).toBeVisible()
    } finally {
      cleanup()
      publishBots(previousBots)
      useAppStore.setState({ activeWorktreeId: previousWorkspace })
    }
  })

  it('focuses a deep-linked page and forgets it when its connector is removed', async () => {
    const first = bot({ linear: { workspaceId: 'org-1', workspaceName: 'Acme' } })
    openBotConnectorPage(botConnectorRowKey(first, 'linear:org-1'))
    renderWith(first, installedSlack)
    expect(await screen.findByRole('button', { name: 'Connectors' })).toHaveFocus()
    cleanup()
    const show = renderWith({ ...first, linear: null }, installedSlack)
    expect(await screen.findByRole('button', { name: 'Slack · Globex' })).toBeVisible()
    show(first)
    expect(await screen.findByRole('button', { name: 'Linear · Acme' })).toBeVisible()
  })

  it('restores an open Google page when its host read recovers', async () => {
    const googleStatus = vi.fn(() => ({ accounts: [], client: null, bots: [] }))
    renderWith(bot({ google: true }), installedSlack, gitHubOff, googleStatus)
    fireEvent.click(await screen.findByRole('button', { name: 'Google' }))
    expect(screen.getByRole('heading', { name: 'Google' })).toBeVisible()
    googleStatus.mockImplementationOnce(() => {
      throw new Error('offline')
    })
    await act(() => refreshGoogle({ kind: 'local' }))
    expect(screen.queryByRole('heading', { name: 'Google' })).toBeNull()
    await act(() => refreshGoogle({ kind: 'local' }))
    expect(screen.getByRole('heading', { name: 'Google' })).toBeVisible()
  })

  it('keeps the list open when a pending Slack installation finishes loading', async () => {
    renderWith(bot(), { state: 'created', appId: 'A1', teamId: 'T05' })
    await screen.findByText('Finish setup')
    expect(screen.getByRole('button', { name: 'Slack' })).toBeVisible()
  })

  it('opens a connector as its own page, and Back or Esc returns to the list on its row', async () => {
    const user = userEvent.setup()
    renderWith(bot({ github: {} }), installedSlack, gitHubOn)
    await screen.findByText('installed by U07')
    const slack = screen.getByRole('button', { name: 'Slack · Globex' })
    expect(screen.queryByRole('heading', { name: 'Slack · Globex' })).toBeNull()

    slack.focus()
    await user.keyboard('{Enter}')
    // The page replaces the list: its heading and body, no other connector.
    expect(screen.getByRole('heading', { name: 'Slack · Globex' })).toBeVisible()
    expect(screen.getByText('Who can ask')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'GitHub · acme' })).toBeNull()
    // Its ⋯ menu opens without leaving the page.
    await user.click(screen.getByRole('button', { name: 'Slack · Globex actions' }))
    expect(await screen.findByRole('menuitem', { name: /Remove|Disconnect/ })).toBeDefined()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('heading', { name: 'Slack · Globex' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Connectors' }))
    expect(screen.queryByRole('heading', { name: 'Slack · Globex' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Slack · Globex' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'GitHub · acme' }))
    expect(screen.getByRole('heading', { name: 'GitHub · acme' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('heading', { name: 'GitHub · acme' })).toBeNull()
    expect(screen.getByRole('button', { name: 'GitHub · acme' })).toHaveFocus()
  })

  it('keeps the page open when the list shows again, and starts another bot on its list', async () => {
    const user = userEvent.setup()
    const first = bot({ id: 'bot-1' })
    renderWith(first, installedSlack)
    await user.click(await screen.findByRole('button', { name: 'Slack · Globex' }))
    cleanup()

    // Leaving the tab and coming back.
    const show = renderWith(first, installedSlack)
    expect(await screen.findByRole('heading', { name: 'Slack · Globex' })).toBeVisible()

    // Another bot, the section never unmounting, then back: each starts on its list.
    show(bot({ id: 'bot-2', name: 'Pilot' }))
    expect(await screen.findByRole('button', { name: 'Slack · Globex' })).toBeVisible()
    show(first)
    expect(await screen.findByRole('button', { name: 'Slack · Globex' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Slack · Globex' })).toBeNull()
  })
})
