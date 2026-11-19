// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), openUrl: vi.fn(), confirm: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))

import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { ComposioToolRow } from './ComposioToolRow'
import { resetComposioClientForTest } from './composio-client'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test bot with the fields the row reads.
const bot = { id: 'bot-1', hostId: 'local', name: 'Atlas', agent: 'claude' } as Bot

function show() {
  return render(
    <ConfirmationDialogContext.Provider value={mocks.confirm}>
      <ComposioToolRow bot={bot} />
    </ConfirmationDialogContext.Provider>
  )
}

function answer(key: string, extra: Record<string, unknown> = {}) {
  mocks.rpc.mockReset().mockImplementation(async (_target: unknown, method: string) => {
    const answers: Record<string, unknown> = {
      'bots.composio.status': { key, added: key === 'ok', limit: null },
      'bots.composio.key': { key, hint: key === 'ok' ? 'ab12' : null },
      'bots.composio.connections': {
        connections: [
          { id: 'ca_1', app: 'outlook', name: 'Outlook', status: 'active', label: 'dana@acme.com' }
        ],
        pending: []
      },
      'bots.composio.apps': {
        apps: [
          {
            slug: 'hubspot',
            name: 'HubSpot',
            description: 'Contacts and deals',
            logo: null,
            signIn: 'composio'
          },
          { slug: 'salesforce', name: 'Salesforce', description: '', logo: null, signIn: 'own' }
        ],
        nextCursor: null
      },
      ...extra
    }
    return answers[method]
  })
}

describe('Composio in a bot’s Tools', () => {
  beforeEach(() => {
    mocks.openUrl.mockClear()
    Object.assign(window, { api: { shell: { openUrl: mocks.openUrl } } })
  })
  afterEach(() => {
    cleanup()
    resetComposioClientForTest()
  })

  it('opens on the key step before a key, with no app list', async () => {
    answer('none')
    show()
    expect(await screen.findByLabelText('Composio API key')).toBeTruthy()
    expect(screen.queryByLabelText('Search Composio’s apps')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Get a key/ }))
    expect(mocks.openUrl).toHaveBeenCalledWith(
      'https://dashboard.composio.dev/~/project/settings/api-keys'
    )
  })

  it('shows sign-ins and opens a supported app’s sign-in in the browser', async () => {
    answer('ok', { 'bots.composio.connect': { url: 'https://connect.composio.dev/link/lk_1' } })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Composio apps' }))
    expect(await screen.findByText('Connected as dana@acme.com')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Connect HubSpot' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Set up in Composio/ })).toBeTruthy()
    expect(screen.getByText('Needs your own Salesforce developer app')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Connect Salesforce' })).toBeNull()
    expect(screen.getByText('1 connected · Your app sign-ins are held by Composio.')).toBeTruthy()

    fireEvent.click(await screen.findByRole('button', { name: 'Connect HubSpot' }))
    await waitFor(() =>
      expect(mocks.openUrl).toHaveBeenCalledWith('https://connect.composio.dev/link/lk_1')
    )
    expect(mocks.rpc).toHaveBeenCalledWith(expect.anything(), 'bots.composio.connect', {
      botId: 'bot-1',
      app: 'hubspot'
    })
  })

  it('asks for a new key when Composio refused it', async () => {
    answer('rejected')
    show()
    expect(await screen.findByText('Key not accepted')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Replace key' })).toBeTruthy()
  })

  it('can cancel replacing a key and removes it only after the owner confirms', async () => {
    answer('ok', { 'bots.composio.removeKey': { key: 'none' } })
    mocks.confirm.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Composio apps' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }))
    expect(await screen.findByRole('button', { name: 'Replace key' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    const remove = await screen.findByRole('button', { name: 'Remove' })
    fireEvent.click(remove)
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1))
    expect(mocks.rpc).not.toHaveBeenCalledWith(expect.anything(), 'bots.composio.removeKey', {
      alsoEvents: false
    })
    fireEvent.click(remove)
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(expect.anything(), 'bots.composio.removeKey', {
        alsoEvents: false
      })
    )
    expect(mocks.rpc).not.toHaveBeenCalledWith(expect.anything(), 'bots.composio.remove', {
      botId: 'bot-1'
    })
  })

  it('shows six rows first, the bot’s own apps among them, and Show more lists the rest', async () => {
    const apps = Array.from({ length: 10 }, (_, index) => ({
      slug: `app${index}`,
      name: `App ${index}`,
      description: '',
      logo: null,
      signIn: 'composio'
    }))
    answer('ok', { 'bots.composio.apps': { apps, nextCursor: null } })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Composio apps' }))
    expect(await screen.findByText('App 4')).toBeTruthy()
    expect(screen.queryByText('App 5')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(await screen.findByText('App 9')).toBeTruthy()
  })

  it('shows Composio’s plan limit on the row, with Check again and its usage page', async () => {
    answer('ok', { 'bots.composio.status': { key: 'ok', added: true, limit: { retryAt: null } } })
    show()
    expect(await screen.findByText('Composio’s plan limit reached')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(expect.anything(), 'bots.composio.checkLimit', null)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Composio apps' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open usage' }))
    expect(mocks.openUrl).toHaveBeenCalledWith(
      'https://dashboard.composio.dev/~/project/settings/usage'
    )
  })

  it('offers Add for an app with no sign-in while the bot has no Composio tool', async () => {
    answer('ok', {
      'bots.composio.status': { key: 'ok', added: false, limit: null },
      'bots.composio.apps': {
        apps: [
          { slug: 'hackernews', name: 'Hacker News', description: '', logo: null, signIn: 'none' }
        ],
        nextCursor: null
      }
    })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Composio apps' }))
    expect(await screen.findByText('No sign-in needed')).toBeTruthy()
    expect(screen.queryByText('Ready · no sign-in needed')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(expect.anything(), 'bots.composio.add', {
        botId: 'bot-1'
      })
    )
  })
})
