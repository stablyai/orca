// @vitest-environment happy-dom

import { withBotConnectorRuntime } from '../../lib/bot-connector-host-calls.test-fixture'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { useAppStore } from '@/store'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  readGitHubInstallRecord,
  resetGitHubInstallForTests
} from '@/lib/bot-github-install-record'
import { AddConnectorButton as Button } from './AddConnectorButton'

const declineConfirm = async (): Promise<boolean> => false

// The app's root provides tooltips and confirms; the dialogs need both.
function AddConnectorButton(props: { bot: Bot }): React.JSX.Element {
  return (
    <ConfirmationDialogContext.Provider value={declineConfirm}>
      <TooltipProvider>
        <Button
          {...props}
          trigger={(open) => (
            <button type="button" onClick={open}>
              Add connector
            </button>
          )}
        />
      </TooltipProvider>
    </ConfirmationDialogContext.Provider>
  )
}
import { setWebhookHostTransportForTests } from './webhooks/webhook-host-client'
import { webhookSummaryFixture } from './webhooks/webhook-summary.test-fixture'

// Orca's own connectors only: the vendor MCP apps listed beside them are catalog data.
vi.mock('../../../../shared/bots/bot-mcp-apps', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  BOT_MCP_APPS: []
}))
const askBotInChat = vi.hoisted(() => vi.fn())
vi.mock('./webhooks/ask-bot-in-chat', () => ({ askBotInChat }))
const updateBot = vi.hoisted(() => vi.fn())
const openBotHome = vi.hoisted(() => vi.fn(() => true))
vi.mock('@/lib/bot-catalog', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  updateBot,
  openBotHome
}))

const bot: Bot = {
  id: 'bot-1',
  name: 'Reviewer',
  hostId: 'local',
  folder: 'reviewer',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

const linearOff = { ok: false, error: 'linear_off' }
const linearReady = {
  ok: true,
  value: { workspaces: [], installUrl: 'https://connector.example/linear/install' }
}
const botLinear = { state: vi.fn() }
const gitHubState = {
  installUrl: 'https://connector.example/github/install?state=s',
  account: null,
  installations: [],
  defaultBotId: null
}
const botGitHub = { state: vi.fn() }

const NAMES = ['Slack', 'Discord', 'Google', 'Linear', 'GitHub', 'Webhooks']

/** Connector names listed under one group heading, in order. */
function groupItems(heading: RegExp): string[] {
  return names(within(screen.getByRole('region', { name: heading })).getAllByRole('listitem'))
}

/** The apps All apps offers to add, across its categories, in order. */
function addable(): string[] {
  return names(
    screen
      .getAllByRole('region')
      .filter((region) => !/Composio/.test(region.getAttribute('aria-label') ?? ''))
      .flatMap((region) => within(region).getAllByRole('listitem'))
  )
}

/** The bot's own apps, under On <bot>. */
function onBot(): string[] {
  fireEvent.click(screen.getByRole('button', { name: /^On Reviewer/ }))
  return groupItems(/On Reviewer/)
}

function names(items: HTMLElement[]): string[] {
  return items.map((item) => NAMES.find((name) => item.textContent?.startsWith(name)) ?? '')
}

beforeEach(() => {
  botLinear.state.mockReset().mockResolvedValue(linearOff)
  botGitHub.state.mockReset().mockResolvedValue({ ok: false, error: 'github_off' })
  Object.assign(window, { api: withBotConnectorRuntime({ botLinear, botGitHub }) })
})

afterEach(() => {
  cleanup()
  resetGitHubInstallForTests()
  setWebhookHostTransportForTests(null)
  askBotInChat.mockReset()
  Reflect.deleteProperty(window, 'api')
})

describe('AddConnectorButton', () => {
  it('lists Slack as the one connector that can be added, and adding it starts Slack setup', async () => {
    const state = vi.fn().mockResolvedValue({ ok: true, value: { state: 'not_created' } })
    Object.assign(window, {
      api: withBotConnectorRuntime({ botSlack: { state }, botLinear, botGitHub })
    })
    render(<AddConnectorButton bot={bot} />)
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }))

    expect(screen.getByText('Add to Reviewer')).toBeTruthy()
    // Linear and GitHub stay unlisted while the cloud answers their routes 404.
    await waitFor(() => expect(botLinear.state).toHaveBeenCalled())
    await waitFor(() => expect(botGitHub.state).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /^On Reviewer/ })).toBeNull()
    expect(addable()).toEqual(['Slack', 'Google'])
    expect(screen.queryByText('Discord')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Add Slack' }))
    expect(screen.queryByText('Add to Reviewer')).toBeNull()
    expect(screen.getByText('Add Reviewer to Slack')).toBeTruthy()
    await waitFor(() => expect(state).toHaveBeenCalledWith({ botId: 'bot-1' }))
  })

  it('narrows every group to the connectors whose name or description matches', async () => {
    render(<AddConnectorButton bot={{ ...bot, slack: { appId: 'A1', teamId: 'T1' } }} />)
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }))
    await waitFor(() => expect(botGitHub.state).toHaveBeenCalled())

    fireEvent.change(screen.getByRole('textbox', { name: 'Search apps' }), {
      target: { value: '  HAND THE BOT ' }
    })
    expect(screen.queryByRole('region', { name: 'Apps' })).toBeNull()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'slack' } })
    // Search lists what the bot has too, with Manage in place of Add.
    expect(groupItems(/^Apps$/)).toEqual(['Slack'])
    expect(screen.getByRole('button', { name: 'Manage Slack' })).toBeTruthy()
  })

  it('says when nothing matches, and Clear search brings the full list back', () => {
    render(<AddConnectorButton bot={bot} />)
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }))
    const search = screen.getByRole('textbox', { name: 'Search apps' })

    fireEvent.change(search, { target: { value: 'xyzzy' } })
    expect(screen.getByText(/No app matches “xyzzy”/)).toBeTruthy()
    expect(screen.queryAllByRole('region')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(search).toHaveProperty('value', '')
    expect(document.activeElement).toBe(search)
    expect(addable()).toEqual(['Slack', 'Google'])
  })

  it('finds an app Composio offers, and asks for the Composio account before its sign-in', () => {
    render(<AddConnectorButton bot={bot} />)
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search apps' }), {
      target: { value: 'jira' }
    })
    expect(
      within(screen.getByRole('region', { name: 'With Composio' })).getByRole('button', {
        name: 'Add Jira'
      })
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add Outlook' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add Jira' }))
    expect(screen.getByText('Connect your Composio account')).toBeTruthy()
    expect(screen.getByText(/Then you sign in to Jira on Composio’s page/)).toBeTruthy()
  })

  it('starts with an empty search each time it opens', () => {
    render(<AddConnectorButton bot={bot} />)
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'jira' } })
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByText('Add to Reviewer')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }))
    expect(screen.getByRole('textbox')).toHaveProperty('value', '')
  })

  it('shows Slack as added, where Add another workspace sets the bot up in another one', async () => {
    const state = vi.fn().mockResolvedValue({ ok: true, value: { state: 'not_created' } })
    Object.assign(window, {
      api: withBotConnectorRuntime({ botSlack: { state }, botLinear, botGitHub })
    })
    render(<AddConnectorButton bot={{ ...bot, slack: { appId: 'A1', teamId: 'T1' } }} />)
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }))

    expect(onBot()).toEqual(['Slack'])
    fireEvent.click(screen.getByRole('button', { name: 'Add another workspace' }))
    expect(screen.queryByText('Add to Reviewer')).toBeNull()
    expect(screen.getByText('Add Reviewer to another Slack workspace')).toBeTruthy()
    // No other workspace on this computer: a new one starts from its token.
    expect(await screen.findByRole('button', { name: 'Create Slack app' })).toBeTruthy()
  })

  it('opens the bot page’s Connectors tab from Manage Webhooks, and only closes from Settings', async () => {
    setWebhookHostTransportForTests(vi.fn(async () => ({ hooks: [webhookSummaryFixture()] })))
    const setRightSidebarTab = vi.fn()
    const setRightSidebarOpen = vi.fn()
    useAppStore.setState({ activeView: 'terminal', setRightSidebarTab, setRightSidebarOpen })
    render(<AddConnectorButton bot={bot} />)
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }))
    fireEvent.click(await screen.findByRole('button', { name: /^On Reviewer/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Manage Webhooks' }))
    expect(screen.queryByText('Add to Reviewer')).toBeNull()
    expect(openBotHome).toHaveBeenCalledWith(bot)
    expect(setRightSidebarTab).toHaveBeenCalledWith('bot-connectors')
    expect(setRightSidebarOpen).toHaveBeenCalledWith(true)

    useAppStore.setState({ activeView: 'settings' })
    setRightSidebarTab.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }))
    fireEvent.click(await screen.findByRole('button', { name: /^On Reviewer/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Manage Webhooks' }))
    expect(setRightSidebarTab).not.toHaveBeenCalled()
  })

  it('offers Linear once the cloud has it, and adding it starts Linear setup', async () => {
    botLinear.state.mockResolvedValue(linearReady)
    render(<AddConnectorButton bot={bot} />)
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }))

    await waitFor(() => expect(addable()).toEqual(['Slack', 'Linear', 'Google']))
    fireEvent.click(screen.getByRole('button', { name: 'Add Linear' }))

    expect(await screen.findByText('for Reviewer')).toBeTruthy()
    expect(await screen.findByRole('button', { name: /Connect Linear/ })).toBeTruthy()
  })

  it('shows a bot on Linear as added', () => {
    render(
      <AddConnectorButton
        bot={{ ...bot, linear: { workspaceId: 'org-1', workspaceName: 'Acme' } }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }))

    expect(onBot()).toEqual(['Linear'])
  })

  it('offers GitHub once the cloud has it, and adding it starts GitHub setup', async () => {
    botGitHub.state.mockResolvedValue({ ok: true, value: gitHubState })
    render(<AddConnectorButton bot={bot} />)
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }))

    await waitFor(() => expect(addable()).toEqual(['GitHub', 'Slack', 'Google']))
    fireEvent.click(screen.getByRole('button', { name: 'Add GitHub' }))

    // The app-wide setup mount shows it, so it outlives this bot's page.
    expect(readGitHubInstallRecord()).toMatchObject({
      bot: { hostId: bot.hostId, id: 'bot-1' },
      surface: 'dialog'
    })
  })

  it('shows a bot on GitHub as added, where Add another org opens GitHub’s install page', async () => {
    botGitHub.state.mockResolvedValue({ ok: true, value: gitHubState })
    const openUrl = vi.fn()
    Object.assign(window, {
      api: withBotConnectorRuntime({ botLinear, botGitHub, shell: { openUrl } })
    })
    render(<AddConnectorButton bot={{ ...bot, github: {} }} />)
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }))

    await waitFor(() => expect(onBot()).toEqual(['GitHub']))
    fireEvent.click(screen.getByRole('button', { name: 'Add another org' }))
    expect(openUrl).toHaveBeenCalledWith(gitHubState.installUrl)
    expect(screen.queryByText('Add Reviewer to GitHub')).toBeNull()
  })

  it('lists orgs taken off the bot that still have Orca, and Add back puts it there at once', async () => {
    updateBot.mockReset().mockResolvedValue({})
    botGitHub.state.mockResolvedValue({
      ok: true,
      value: {
        ...gitHubState,
        account: { userId: '42', login: 'dana' },
        installations: [
          { installationId: '7', accountLogin: 'acme', repositories: null },
          { installationId: '8', accountLogin: 'old-org', repositories: null }
        ]
      }
    })
    render(<AddConnectorButton bot={{ ...bot, github: { removedInstallationIds: ['8', '9'] } }} />)
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }))
    fireEvent.click(screen.getByRole('button', { name: /^On Reviewer/ }))

    fireEvent.click(await screen.findByRole('button', { name: 'Add old-org back' }))
    expect(updateBot).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }), {
      github: { removedInstallationIds: ['9'] }
    })
    // An org the bot is still in has nothing to add back.
    expect(screen.queryByRole('button', { name: 'Add acme back' })).toBeNull()
  })

  it('offers Webhooks once the host has them, and Set up in chat opens the bot’s Chat with it typed', async () => {
    setWebhookHostTransportForTests(vi.fn(async () => ({ hooks: [] })))
    render(<AddConnectorButton bot={bot} />)
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Webhooks' }))

    fireEvent.click(screen.getByRole('button', { name: 'Set up in chat' }))
    expect(askBotInChat).toHaveBeenCalledWith(bot, 'Set up a webhook that ')
    expect(screen.queryByText('Add to Reviewer')).toBeNull()
  })

  it('lists Webhooks as added once the bot has a hook', async () => {
    setWebhookHostTransportForTests(vi.fn(async () => ({ hooks: [webhookSummaryFixture()] })))
    render(<AddConnectorButton bot={bot} />)
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }))
    await waitFor(() => expect(onBot()).toEqual(['Webhooks']))
  })

  it('leaves Webhooks out while the cloud or this Orca has none', async () => {
    const host = vi.fn(async () => {
      throw new Error('webhooks_unavailable')
    })
    setWebhookHostTransportForTests(host)
    render(<AddConnectorButton bot={bot} />)
    fireEvent.click(screen.getByRole('button', { name: /Add connector/ }))
    await waitFor(() => expect(host).toHaveBeenCalled())
    expect(screen.queryByText('Webhooks')).toBeNull()
  })
})
