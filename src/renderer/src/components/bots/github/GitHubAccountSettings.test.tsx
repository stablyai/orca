// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorGitHubState } from '../../../../../shared/connector-bot-github-contract'

const mocks = vi.hoisted(() => {
  const github: { state: unknown } = { state: null }
  return { github, unlink: vi.fn(), refresh: vi.fn() }
})
vi.mock('@/lib/bot-github-state', () => ({
  useBotGitHub: () => ({ status: 'ready', github: mocks.github.state }),
  refreshBotGitHub: mocks.refresh
}))
vi.mock('@/lib/bot-connector-host-calls', () => ({
  botGitHubCalls: () => ({ unlink: mocks.unlink, setDefaultBot: vi.fn() })
}))
vi.mock('@/lib/bot-catalog', () => ({ useHostBots: () => [] }))
vi.mock('@/lib/connector-connect-state', () => ({
  connectAnotherAccount: vi.fn(),
  useConnectorConnect: () => ({ status: 'idle' })
}))
vi.mock('../use-bot-host-label', () => ({ useBotHostLabel: () => null }))

import { GitHubAccountSettings } from './GitHubAccountSettings'

const linked = (linkedAccounts?: ConnectorGitHubState['linkedAccounts']): ConnectorGitHubState => ({
  installUrl: 'https://connector.example/github/install',
  account: { userId: '7', login: 'octo-owner' },
  installations: [],
  defaultBotId: null,
  ...(linkedAccounts ? { linkedAccounts } : {})
})

beforeEach(() => {
  mocks.unlink.mockReset().mockResolvedValue({ ok: true, value: undefined })
  mocks.refresh.mockReset().mockResolvedValue(undefined)
})
afterEach(cleanup)

describe('GitHub account settings', () => {
  it('lists every Orca account linked to the login, marks this one, and unlinks only it', async () => {
    mocks.github.state = linked([
      { current: true, machines: ['Studio'], linkedAt: 2 },
      { current: false, machines: ['MacBook Pro', 'build-box'], linkedAt: 1 }
    ])
    render(<GitHubAccountSettings hostId="local" hostName={null} />)
    expect(screen.getByText('Orca accounts linked to octo-owner')).toBeTruthy()
    const rows = screen.getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      'StudioThis accountUnlink',
      'MacBook Pro, build-box'
    ])
    const unlinks = screen.getAllByRole('button', { name: 'Unlink' })
    expect(unlinks).toHaveLength(1)
    fireEvent.click(unlinks[0]!)
    await waitFor(() => expect(mocks.unlink).toHaveBeenCalledTimes(1))
    expect(mocks.refresh).toHaveBeenCalledWith('local')
  })

  it('shows a link only this account holds as before, with no list', () => {
    for (const state of [
      linked(),
      linked([{ current: true, machines: ['Studio'], linkedAt: 1 }])
    ]) {
      mocks.github.state = state
      render(<GitHubAccountSettings hostId="local" hostName={null} />)
      expect(screen.queryByRole('list')).toBeNull()
      expect(screen.getByText('Linked as octo-owner')).toBeTruthy()
      expect(screen.getAllByRole('button', { name: 'Unlink' })).toHaveLength(1)
      cleanup()
    }
  })
})
