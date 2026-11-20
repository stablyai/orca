// @vitest-environment happy-dom

import { withBotConnectorRuntime } from '../../../lib/bot-connector-host-calls.test-fixture'
import '@testing-library/jest-dom/vitest'
import type { ReactElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorBotSlackStateResponse } from '../../../../../shared/connector-bot-slack-contract'
import { useAppStore } from '@/store'
import { ORCA_SIGNED_OUT, orcaSignIn } from '@/components/bots/orca-sign-in.test-fixture'
import { forgetBotConnectorRowsOpen } from '@/components/bots/bot-connector-row-open'
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

function sectionFor(subject: Bot): ReactElement {
  return (
    <ConfirmationDialogContext.Provider value={confirm}>
      <TooltipProvider>
        <BotConnectorsSection bot={subject} />
      </TooltipProvider>
    </ConfirmationDialogContext.Provider>
  )
}

/** Renders the section; the returned call shows another bot in the same, still mounted, section. */
function renderWith(
  subject: Bot,
  slack: ConnectorBotSlackStateResponse,
  github: unknown = gitHubOff
): (next: Bot) => void {
  Object.assign(window, {
    api: withBotConnectorRuntime({
      botSlack: {
        state: slackState.mockResolvedValue({ ok: true, value: slack })
      },
      botLinear: { state: vi.fn().mockResolvedValue(linearState) },
      botGitHub: { state: vi.fn().mockResolvedValue(github) }
    })
  })
  const { rerender } = render(sectionFor(subject))
  return (next) => rerender(sectionFor(next))
}

afterEach(() => {
  cleanup()
  // Each test is a new session: no row remembers how an earlier one left it.
  forgetBotConnectorRowsOpen()
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
    fireEvent.click(screen.getByRole('button', { name: 'Linear · Acme' }))
    fireEvent.click(screen.getByRole('button', { name: 'Slack' }))
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
    // Only the workspace waiting on its install shows a status.
    expect(await screen.findByText('Waiting for the install in Slack.')).toBeDefined()
    expect(screen.getAllByText(/link your Linear account in Beta/).length).toBeGreaterThan(0)
    // Not linked in Beta yet, so it offers setup there.
    expect(screen.getAllByRole('button', { name: 'Finish setup' }).length).toBeGreaterThan(1)
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

// A row's panel, which its header button names as the part it shows and hides.
function panelOf(header: HTMLElement): HTMLElement {
  return document.getElementById(header.getAttribute('aria-controls') ?? '')!
}

describe('BotConnectorsSection folding', () => {
  it('folds an open connector again from its header, by click or by keyboard', async () => {
    const user = userEvent.setup()
    renderWith(bot({ github: {} }), installedSlack, gitHubOn)
    await screen.findByText('installed by U07')
    const slack = screen.getByRole('button', { name: 'Slack · Globex' })
    const github = screen.getByRole('button', { name: 'GitHub · acme' })
    // Every connector row has a fold control saying whether it is open.
    expect(slack).toHaveAttribute('aria-expanded', 'false')
    expect(github).toHaveAttribute('aria-expanded', 'false')
    expect(panelOf(slack)).not.toBeVisible()

    await user.click(slack)
    expect(slack).toHaveAttribute('aria-expanded', 'true')
    expect(panelOf(slack)).toBeVisible()
    expect(within(panelOf(slack)).getByText('Who can ask')).toBeVisible()

    // The way back: the same header folds it.
    await user.click(slack)
    expect(slack).toHaveAttribute('aria-expanded', 'false')
    expect(panelOf(slack)).not.toBeVisible()

    slack.focus()
    await user.keyboard('{Enter}')
    expect(slack).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard(' ')
    expect(slack).toHaveAttribute('aria-expanded', 'false')
    // One row folding leaves the other alone.
    expect(github).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens the ⋯ menu without folding the row', async () => {
    const user = userEvent.setup()
    renderWith(bot(), installedSlack)
    await screen.findByText('installed by U07')
    const slack = screen.getByRole('button', { name: 'Slack · Globex' })
    await user.click(slack)
    await user.click(screen.getByRole('button', { name: 'Slack · Globex actions' }))
    expect(await screen.findByRole('menuitem', { name: /Remove|Disconnect/ })).toBeDefined()
    expect(slack).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps each row as the owner left it when the list shows again this session', async () => {
    const user = userEvent.setup()
    const notLinked = {
      ok: true,
      value: { ...gitHubOn.value, account: null, installations: [] }
    }
    renderWith(bot({ github: {} }), installedSlack, notLinked)
    await screen.findByText('installed by U07')
    // GitHub opens itself because it needs the owner; the owner closes it and opens Slack.
    await screen.findByRole('button', { name: 'Finish setup' })
    expect(screen.getByRole('button', { name: 'GitHub' })).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('button', { name: 'GitHub' }))
    await user.click(screen.getByRole('button', { name: 'Slack · Globex' }))
    cleanup()

    // Leaving the tab and coming back.
    renderWith(bot({ github: {} }), installedSlack, notLinked)
    await screen.findByText('installed by U07')
    await screen.findByRole('button', { name: 'Finish setup' })
    expect(screen.getByRole('button', { name: 'Slack · Globex' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByRole('button', { name: 'GitHub' })).toHaveAttribute('aria-expanded', 'false')
    cleanup()

    // Another bot's Slack row is its own.
    renderWith(bot({ id: 'bot-2' }), installedSlack)
    await screen.findByText('installed by U07')
    expect(screen.getByRole('button', { name: 'Slack · Globex' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  it('keeps each bot its own rows when the shown bot changes in place', async () => {
    const user = userEvent.setup()
    const notLinked = {
      ok: true,
      value: { ...gitHubOn.value, account: null, installations: [] }
    }
    const first = bot({ id: 'bot-1', github: {} })
    const second = bot({ id: 'bot-2', name: 'Pilot', github: {} })
    const show = renderWith(first, installedSlack, notLinked)
    await screen.findByText('installed by U07')
    await screen.findByRole('button', { name: 'Finish setup' })
    const expanded = (name: string): string | null =>
      screen.getByRole('button', { name }).getAttribute('aria-expanded')
    expect([expanded('Slack · Globex'), expanded('GitHub')]).toEqual(['false', 'true'])
    // Open Slack and close GitHub for the first bot.
    await user.click(screen.getByRole('button', { name: 'Slack · Globex' }))
    await user.click(screen.getByRole('button', { name: 'GitHub' }))
    expect([expanded('Slack · Globex'), expanded('GitHub')]).toEqual(['true', 'false'])

    // Straight to the second bot, the section never unmounting: its own rows, and GitHub
    // opens itself because the owner never closed it there.
    show(second)
    await screen.findAllByText('Who can ask Pilot')
    expect([expanded('Slack · Globex'), expanded('GitHub')]).toEqual(['false', 'true'])

    // Back and forth: each bot's rows are as the owner left them, neither written over.
    show(first)
    await screen.findAllByText('Who can ask Scout')
    expect([expanded('Slack · Globex'), expanded('GitHub')]).toEqual(['true', 'false'])
    show(second)
    await screen.findAllByText('Who can ask Pilot')
    expect([expanded('Slack · Globex'), expanded('GitHub')]).toEqual(['false', 'true'])
  })
})
