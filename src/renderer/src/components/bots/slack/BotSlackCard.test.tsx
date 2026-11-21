// @vitest-environment happy-dom

import { withBotConnectorRuntime } from '../../../lib/bot-connector-host-calls.test-fixture'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import type { Bot } from '../../../../../shared/bot-types'
import type {
  ConnectorBotSlackState,
  ConnectorBotSlackStateResponse
} from '../../../../../shared/connector-bot-slack-contract'
import { useAppStore } from '@/store'
import { ORCA_SIGNED_OUT, orcaSignIn } from '../orca-sign-in.test-fixture'
import { BotSlackCard } from './BotSlackCard'

const bot: Bot = {
  id: 'bot-1',
  name: 'Scout',
  hostId: 'local',
  folder: 'scout',
  folderWorkspaceId: 'fw-1',
  agent: 'codex',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [{ id: 'U-sam', name: 'Sam Lee' }],
  slack: { appId: 'A1', teamId: 'T05' },
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

const installed: ConnectorBotSlackState = {
  state: 'installed',
  teamId: 'T05',
  appId: 'A1',
  botUserId: 'UB',
  installerUserId: 'U07'
}

const confirm = vi.fn()
const api = { state: vi.fn(), remove: vi.fn() }

function renderCard(
  slack: ConnectorBotSlackStateResponse,
  options: { teamId?: string; shown?: Bot } = {}
): void {
  const teamId = 'teamId' in options ? options.teamId : 'T05'
  api.state.mockReset().mockResolvedValue({ ok: true, value: slack })
  api.remove.mockReset().mockResolvedValue({ ok: true, value: undefined })
  Object.assign(window, {
    api: withBotConnectorRuntime({ botSlack: api, shell: { openUrl: vi.fn() } })
  })
  render(
    <ConfirmationDialogContext.Provider value={confirm}>
      <BotSlackCard bot={options.shown ?? bot} teamId={teamId} defaultOpen />
    </ConfirmationDialogContext.Provider>
  )
}

afterEach(() => {
  cleanup()
  confirm.mockReset()
  Reflect.deleteProperty(window, 'api')
})

/** Opens the row's ⋯ menu, which holds its page link and Remove. */
function openActions(): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Slack actions' }), {
    button: 0,
    ctrlKey: false
  })
}

describe('BotSlackCard', () => {
  it('offers newer permissions in the menu without asking for them', async () => {
    renderCard({ ...installed, updateAvailable: true })
    await screen.findByText(/installed by/)
    // Nothing is wrong, so no status and no button in the row.
    expect(screen.queryByText('Update needed')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Update in Slack' })).toBeNull()
    openActions()
    expect(await screen.findByRole('menuitem', { name: 'Update Slack permissions…' })).toBeDefined()
  })

  it('turns the status into one Update in Slack link when the app is out of date', async () => {
    renderCard({ ...installed, updateNeeded: true })
    expect(await screen.findByRole('button', { name: 'Update in Slack' })).toBeDefined()
    // The link replaces the status; the row's other actions stay.
    expect(screen.queryByText('Update needed')).toBeNull()
    openActions()
    expect(await screen.findByRole('menuitem', { name: 'Slack app settings' })).toBeDefined()
    expect(screen.getByRole('menuitem', { name: 'Remove from T05…' })).toBeDefined()
  })

  it('reads an installed Slack as paused while signed out, and asks for sign-in for requests', async () => {
    const initial = useAppStore.getState()
    const connect = vi.fn(orcaSignIn())
    useAppStore.setState({
      orcaProfileAuthStatus: ORCA_SIGNED_OUT,
      connectCurrentOrcaProfile: connect
    })
    try {
      api.state.mockReset().mockResolvedValue({ ok: false, error: 'signed_out' })
      Object.assign(window, {
        api: withBotConnectorRuntime({ botSlack: api, shell: { openUrl: vi.fn() } })
      })
      render(
        <ConfirmationDialogContext.Provider value={confirm}>
          <BotSlackCard bot={{ ...bot, id: 'bot-signed-out' }} teamId="T05" defaultOpen />
        </ConfirmationDialogContext.Provider>
      )
      expect(await screen.findByText('Paused while signed out')).toBeDefined()
      expect(screen.getByText('Needs sign-in')).toBeDefined()
      expect(screen.queryByText('Can’t check')).toBeNull()
      expect(screen.queryByText('Sign in to Orca Cloud to connect Slack.')).toBeNull()

      expect(screen.getByText('Access requests need Orca sign-in.')).toBeDefined()
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
      await waitFor(() =>
        expect(screen.queryByText('Access requests need Orca sign-in.')).toBeNull()
      )
      expect(connect).toHaveBeenCalledTimes(1)
    } finally {
      useAppStore.setState(initial, true)
    }
  })

  it('removes from Slack only after the confirm, which carries the note', async () => {
    renderCard(installed)
    confirm.mockResolvedValueOnce(false)
    expect(await screen.findByText('installed by U07')).toBeDefined()
    openActions()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from T05…' }))
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      title: 'Remove Scout from T05?',
      description: 'Removing stops new work from Slack. It does not delete the app in Slack.'
    })
    expect(api.remove).not.toHaveBeenCalled()

    confirm.mockResolvedValueOnce(true)
    openActions()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from T05…' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith({ botId: 'bot-1', teamId: 'T05' }))
  })

  it('keeps setup in the row while the install is pending, with adding people off', async () => {
    renderCard({ state: 'created', teamId: 'T05', appId: 'A1' })
    expect(await screen.findByText('Waiting for the install in Slack.')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Finish setup' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true)
  })

  it.each([
    { state: 'grant_expired', teamId: 'T05' } as const,
    { state: 'uncertain', teamId: 'T05' } as const,
    { state: 'created', teamId: 'T05', appId: 'A1' } as const,
    { state: 'not_created' } as const
  ])('removes the saved workspace when Slack reports %o', async (state) => {
    renderCard(state)
    confirm.mockResolvedValueOnce(true)
    await screen.findByRole('button', { name: /^(Finish setup|Add to Slack)$/ })
    openActions()
    expect(screen.queryByRole('menuitem', { name: 'Slack app settings' })).toBeNull()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from T05…' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith({ botId: 'bot-1', teamId: 'T05' }))
  })

  it('offers no Remove on the people-only row once the install is gone', async () => {
    renderCard(
      { state: 'created', teamId: 'T05', appId: 'A1' },
      { teamId: undefined, shown: { ...bot, slack: null } }
    )
    expect(await screen.findByRole('button', { name: 'Finish setup' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Slack actions' })).toBeNull()
  })

  it('opens and closes the row from its name', async () => {
    api.state.mockReset().mockResolvedValue({
      ok: true,
      value: { ...installed, teamName: 'Globex', installerName: 'Alice' }
    })
    Object.assign(window, {
      api: withBotConnectorRuntime({ botSlack: api, shell: { openUrl: vi.fn() } })
    })
    render(
      <ConfirmationDialogContext.Provider value={confirm}>
        <BotSlackCard bot={bot} teamId="T05" />
      </ConfirmationDialogContext.Provider>
    )
    const toggle = await screen.findByRole('button', { name: 'Slack' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Add people' })).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(await screen.findByRole('button', { name: 'Add people' })).toBeDefined()
    expect(await screen.findByText('installed by Alice')).toBeDefined()
    expect(screen.getByText('Sam Lee')).toBeDefined()
    expect(screen.queryByText('Connected')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Add people' })).toBeNull()
  })

  it('shows one workspace of several: its own state and only its own people', async () => {
    const acme: ConnectorBotSlackState = {
      ...installed,
      teamId: 'T06',
      appId: 'A2',
      teamName: 'Acme',
      installerName: 'Alice'
    }
    renderCard(
      { ...installed, teams: [installed, acme] },
      {
        teamId: 'T06',
        shown: {
          ...bot,
          slackApps: [
            { appId: 'A1', teamId: 'T05' },
            { appId: 'A2', teamId: 'T06' }
          ],
          members: [
            ...bot.members,
            { id: 'U-pri', name: 'Priya', source: 'slack', workspaceId: 'T06' }
          ]
        }
      }
    )
    expect(await screen.findByText('installed by Alice')).toBeDefined()
    expect(screen.getByText('Priya')).toBeDefined()
    // Saved before workspaces, so the first workspace's.
    expect(screen.queryByText('Sam Lee')).toBeNull()
  })
})
