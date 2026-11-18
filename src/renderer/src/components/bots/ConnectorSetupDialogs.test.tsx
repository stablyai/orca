// @vitest-environment happy-dom

import { withBotConnectorRuntime } from '../../lib/bot-connector-host-calls.test-fixture'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshBotGitHub, stopAwaitingGitHub } from '@/lib/bot-github-state'
import type { Bot } from '../../../../shared/bot-types'
import { useConnectorSetup } from './ConnectorSetupDialogs'

const mocks = vi.hoisted(() => ({
  refreshGoogle: vi.fn(),
  importGoogleApp: vi.fn(),
  turnOnGoogle: vi.fn(),
  startGoogleSetupInChat: vi.fn(),
  answerGoogleSetup: vi.fn()
}))
vi.mock('./google/google-connect-client', () => ({
  refreshGoogle: mocks.refreshGoogle,
  importGoogleApp: mocks.importGoogleApp
}))
const openAppHttpLink = vi.hoisted(() => vi.fn())
vi.mock('@/lib/browser/navigation/app-http-link-open', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  openAppHttpLink
}))
vi.mock('./google/use-turn-on-bot-google', () => ({ useTurnOnBotGoogle: () => mocks.turnOnGoogle }))
vi.mock('./google/setup-cards/google-setup-run-store', () => ({
  startGoogleSetupInChat: mocks.startGoogleSetupInChat,
  answerGoogleSetup: mocks.answerGoogleSetup
}))

const bot: Bot = {
  id: 'bot-1',
  name: 'Inbox helper',
  hostId: 'local',
  folder: 'inbox-helper',
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

function Harness({ subject = bot }: { subject?: Bot }): React.JSX.Element {
  const setup = useConnectorSetup(subject)
  return (
    <>
      <button type="button" onClick={() => setup.start('google')}>
        Add Google
      </button>
      <button type="button" onClick={() => setup.start('github')}>
        Add GitHub
      </button>
      {setup.dialogs}
    </>
  )
}

function googleView(
  emails: string[],
  { client = null, status = 'connected' }: { client?: unknown; status?: string } = {}
): unknown {
  return {
    status: 'ready',
    google: { client, accounts: emails.map((email) => ({ email, status, services: [] })) }
  }
}

beforeEach(() => {
  mocks.startGoogleSetupInChat.mockResolvedValue(undefined)
  mocks.answerGoogleSetup.mockResolvedValue(undefined)
  mocks.importGoogleApp.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Add connector › Google', () => {
  it('turns Google on directly when this computer already has an account', async () => {
    mocks.refreshGoogle.mockResolvedValue(googleView(['me@example.com']))
    render(<Harness />)
    fireEvent.click(screen.getByText('Add Google'))
    await waitFor(() => expect(mocks.turnOnGoogle).toHaveBeenCalledWith(bot))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.startGoogleSetupInChat).not.toHaveBeenCalled()
  })

  it.each([
    ['nobody is signed in', googleView([], { client: { clientId: 'c1' } })],
    [
      'its only sign-in ended',
      googleView(['me@example.com'], { client: { clientId: 'c1' }, status: 'reconnect' })
    ]
  ])(
    'goes straight to sign-in, not making an app, when the app is here but %s',
    async (_case, view) => {
      mocks.refreshGoogle.mockResolvedValue(view)
      render(<Harness />)
      fireEvent.click(screen.getByText('Add Google'))
      await waitFor(() =>
        expect(mocks.answerGoogleSetup).toHaveBeenCalledWith(
          expect.objectContaining({ id: bot.id }),
          'path',
          ['import']
        )
      )
      expect(mocks.startGoogleSetupInChat).toHaveBeenCalledWith(bot, 'add-connector')
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(mocks.turnOnGoogle).not.toHaveBeenCalled()
    }
  )

  it('asks how to connect first when no account is set up, with Orca hosted not yet offered', async () => {
    mocks.refreshGoogle.mockResolvedValue(googleView([]))
    render(<Harness />)
    fireEvent.click(screen.getByText('Add Google'))
    await screen.findByRole('dialog', { name: 'Connect Google' })
    expect(screen.getByRole('radio', { name: /Orca hosted/ })).toHaveProperty('disabled', true)
    expect(screen.getByRole('radio', { name: 'Self hosted' }).getAttribute('data-state')).toBe(
      'checked'
    )
    expect(screen.getByText('Inbox helper opens Google Cloud and sets up the app')).toBeTruthy()
    expect(mocks.startGoogleSetupInChat).not.toHaveBeenCalled()
    expect(mocks.turnOnGoogle).not.toHaveBeenCalled()
  })

  it('Continue starts the setup in the bot’s chat and closes', async () => {
    mocks.refreshGoogle.mockResolvedValue(googleView([]))
    render(<Harness />)
    fireEvent.click(screen.getByText('Add Google'))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(mocks.startGoogleSetupInChat).toHaveBeenCalledWith(bot, 'add-connector')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mocks.answerGoogleSetup).not.toHaveBeenCalled()
  })

  it('Import file adds the team’s app, then starts the setup on the import path', async () => {
    mocks.refreshGoogle.mockResolvedValue(googleView([]))
    const pickClientFile = vi.fn().mockResolvedValue({ ok: true, text: '{"installed":{}}' })
    render(<Harness />)
    fireEvent.click(screen.getByText('Add Google'))
    const importButton = await screen.findByRole('button', { name: 'Import file' })
    Object.assign(window, {
      api: withBotConnectorRuntime({ ...window.api, googleSetup: { pickClientFile } })
    })
    await act(async () => {
      fireEvent.click(importButton)
    })
    await waitFor(() =>
      expect(mocks.answerGoogleSetup).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bot-1' }),
        'path',
        ['import']
      )
    )
    expect(mocks.importGoogleApp).toHaveBeenCalledWith(expect.anything(), '{"installed":{}}')
    expect(mocks.startGoogleSetupInChat).toHaveBeenCalledWith(bot, 'add-connector')
  })
})

describe('Add connector › GitHub', () => {
  it('opens GitHub’s install page per Orca’s link setting when the bot is already on GitHub', async () => {
    const installUrl = 'https://connector.example/github/install?state=s'
    const openUrl = vi.fn()
    const state = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        installUrl,
        account: { userId: '42', login: 'dana' },
        installations: [],
        defaultBotId: null
      }
    })
    Object.assign(window, {
      api: withBotConnectorRuntime({ ...window.api, shell: { openUrl }, botGitHub: { state } })
    })
    await refreshBotGitHub('local')
    render(<Harness subject={{ ...bot, github: {} }} />)
    fireEvent.click(screen.getByText('Add GitHub'))
    expect(openAppHttpLink).toHaveBeenCalledWith(installUrl)
    expect(openUrl).not.toHaveBeenCalled()
    stopAwaitingGitHub('local')
  })
})
