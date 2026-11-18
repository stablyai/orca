// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), openUrl: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/bot-catalog', () => ({
  openBotHomeTab: vi.fn(),
  useBots: () => [{ hostId: 'local', id: 'bot-1', name: 'Atlas' }]
}))

import { ComposioSetupChatCard } from './ComposioSetupChatCard'
import { resetComposioClientForTest } from './composio-client'

const card = { botId: 'bot-1', card: 'connect' as const, app: { slug: 'twitter', name: 'X' } }

function hostSays(signIns: string[]) {
  mocks.rpc.mockReset().mockImplementation(async (_target: unknown, method: string) => {
    if (method === 'bots.composio.status') {
      return { key: 'ok', added: true }
    }
    if (method === 'bots.composio.connections') {
      return { connections: [], pending: [] }
    }
    if (method === 'bots.composio.app') {
      return { slug: 'twitter', name: 'X', description: '', logo: null, signIn: signIns.shift() }
    }
    return {}
  })
}

describe('the Composio Connect card', () => {
  beforeEach(() => {
    Object.assign(window, { api: { shell: { openUrl: mocks.openUrl } } })
  })
  afterEach(() => {
    cleanup()
    resetComposioClientForTest()
  })

  it('walks the owner through an app’s one-time setup, then Check again turns it into Connect', async () => {
    hostSays(['own', 'own', 'composio'])
    render(<ComposioSetupChatCard card={card} fallback="fallback" />)
    expect(await screen.findByText('X needs a one-time setup in Composio')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Connect X' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Open Auth Configs/ }))
    expect(mocks.openUrl).toHaveBeenCalledWith(
      'https://dashboard.composio.dev/~/project/auth-configs'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText('Composio has no Auth Config for X yet.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByRole('button', { name: 'Connect X' })).toBeTruthy()
  })

  it('tells the owner an API-key app opens Composio to enter its key', async () => {
    hostSays(['key'])
    render(<ComposioSetupChatCard card={card} fallback="fallback" />)
    expect(
      await screen.findByText(
        'Opens Composio to enter your X API key. Composio keeps it, not Orca.'
      )
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect X' })).toBeTruthy()
  })

  it('a Ready card names the account when Composio gives one, and nothing for an API-key app', async () => {
    const connected = (label: string | null) =>
      mocks.rpc.mockReset().mockImplementation(async (_target: unknown, method: string) => {
        if (method === 'bots.composio.status') {
          return { key: 'ok', added: true }
        }
        if (method === 'bots.composio.connections') {
          const connection = { id: 'ca_1', app: 'twitter', name: 'X', status: 'active', label }
          return { connections: [connection], pending: [] }
        }
        return {}
      })
    connected('dana@acme.com')
    const first = render(
      <ComposioSetupChatCard card={{ ...card, card: 'ready' }} fallback="fallback" />
    )
    expect(
      await screen.findByText('As dana@acme.com. Your app sign-ins are held by Composio.')
    ).toBeTruthy()
    first.unmount()
    resetComposioClientForTest()
    connected(null)
    render(<ComposioSetupChatCard card={{ ...card, card: 'ready' }} fallback="fallback" />)
    expect(await screen.findByText('Your app sign-ins are held by Composio.')).toBeTruthy()
  })

  it('says an old Ready card no longer holds once the key or the bot’s tool is gone', async () => {
    mocks.rpc
      .mockReset()
      .mockImplementation(async (_target: unknown, method: string) =>
        method === 'bots.composio.status' ? { key: 'none', added: false } : {}
      )
    render(<ComposioSetupChatCard card={{ ...card, card: 'ready' }} fallback="fallback" />)
    expect(await screen.findByText('Atlas can’t use X now')).toBeTruthy()
    expect(screen.queryByText('Atlas can now use X')).toBeNull()
  })
})
