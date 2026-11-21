// @vitest-environment happy-dom

import { withBotConnectorRuntime } from '../../../lib/bot-connector-host-calls.test-fixture'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bot-catalog', () => ({ useHostBots: () => [] }))

import { refreshBotGitHub } from '@/lib/bot-github-state'
import { ConnectorGitHubState } from '../../../../../shared/connector-bot-github-contract'
import { GitHubAccountSettings } from './GitHubAccountSettings'

const STATE: ConnectorGitHubState = {
  installUrl: 'https://github.com/apps/orca/installations/new',
  account: { userId: '42', login: 'dana-acme' },
  installations: [{ installationId: '1', accountLogin: 'acme-corp', repositories: null }],
  defaultBotId: null
}
const api = { botGitHub: { state: vi.fn(), unlink: vi.fn() } }

async function renderWith(state: ConnectorGitHubState): Promise<void> {
  api.botGitHub.state.mockResolvedValue({ ok: true, value: state })
  await refreshBotGitHub('local')
  render(<GitHubAccountSettings hostId="local" hostName={null} />)
}

beforeEach(() => {
  api.botGitHub.state.mockReset()
  api.botGitHub.unlink.mockReset().mockResolvedValue({ ok: true, value: undefined })
  Object.assign(window, { api: withBotConnectorRuntime(api) })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

describe('GitHubAccountSettings', () => {
  it('lists each linked login and unlinks only the one picked', async () => {
    await renderWith({
      ...STATE,
      accounts: [
        { userId: '42', login: 'dana-acme', installations: ['1'], defaultBotId: null },
        { userId: '77', login: 'dana', installations: ['2'], defaultBotId: null }
      ]
    })

    expect(screen.getByText('Linked as dana-acme')).toBeDefined()
    expect(screen.getByText('Linked as dana')).toBeDefined()
    fireEvent.click(screen.getAllByRole('button', { name: 'Unlink' })[1])
    await waitFor(() => expect(api.botGitHub.unlink).toHaveBeenCalledWith({ userId: '77' }))
  })

  it('keeps one row and unlinks the account when the cloud links one login', async () => {
    await renderWith(STATE)

    expect(screen.getByText('Linked as dana-acme')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }))
    await waitFor(() => expect(api.botGitHub.unlink).toHaveBeenCalledWith({}))
  })

  it('still unlinks one login when an entry of the list can’t be read', async () => {
    // The cloud linked two; one entry has a login this build rejects.
    await renderWith(
      ConnectorGitHubState.parse({
        ...STATE,
        accounts: [
          { userId: '42', login: 'dana-acme', installations: ['1'], defaultBotId: null },
          { userId: '77', login: '', installations: ['2'], defaultBotId: null }
        ]
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }))
    await waitFor(() => expect(api.botGitHub.unlink).toHaveBeenCalledWith({ userId: '42' }))
  })
})
