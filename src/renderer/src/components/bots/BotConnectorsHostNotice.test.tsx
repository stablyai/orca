// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'

// A server bot's Connectors notice when the server's own sign-in can't start from here: what it waits on.
type HostRead = {
  account: null | { state: string; storage?: { kind: string } }
  settled: boolean
  connector: string | undefined
  refreshAccount: ReturnType<typeof vi.fn>
}
const host = vi.hoisted((): HostRead => ({
  account: null,
  settled: true,
  connector: 'signed-out',
  refreshAccount: vi.fn()
}))
vi.mock('./use-bot-host-label', () => ({ useBotHostLabel: () => 'box1' }))
vi.mock('@/lib/bot-catalog', () => ({
  readHostBots: () => [],
  useBotHostConnectorStatus: () => host.connector
}))
vi.mock('@/lib/bot-host-status', () => ({
  useBotHostVerified: () => true,
  useBotHostHas: () => true
}))
vi.mock('@/lib/bot-host-orca-account', () => ({
  cancelBotHostSignIn: vi.fn(),
  startBotHostSignIn: vi.fn(),
  refreshBotHostOrcaAccount: host.refreshAccount,
  useBotHostOrcaAccount: () => host.account,
  useBotHostOrcaAccountSettled: () => host.settled,
  useBotHostSignIn: () => ({ phase: 'idle' })
}))

import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { BotConnectorsHostNotice } from './BotConnectorsHostNotice'

const bot = (overrides: Partial<Bot> = {}): Bot =>
  stampBotHost('runtime:box1', {
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
    github: {},
    chatSessionId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  })

afterEach(() => {
  cleanup()
  Object.assign(host, { account: null, settled: true, connector: 'signed-out' })
  host.refreshAccount.mockClear()
})

describe("a server bot's Connectors notice", () => {
  it("says it couldn't read the server's sign-in, with Try again, while its link waits on one", () => {
    render(<BotConnectorsHostNotice bot={bot()} />)
    expect(screen.getByText('Slack, Linear and GitHub aren’t reaching Scout.')).toBeTruthy()
    expect(screen.getByText('Couldn’t read box1’s Orca sign-in.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(host.refreshAccount).toHaveBeenCalledWith('runtime:box1')
  })

  it('says nothing while the read is out, or when the link is fine', () => {
    host.settled = false
    const { container } = render(<BotConnectorsHostNotice bot={bot()} />)
    expect(container.textContent).toBe('')
    cleanup()
    host.settled = true
    host.connector = 'ok'
    const fine = render(<BotConnectorsHostNotice bot={bot()} />)
    expect(fine.container.textContent).toBe('')
  })

  it('says the server was built without Orca Cloud sign-in, for a bot with links', () => {
    host.account = { state: 'unconfigured' }
    host.connector = undefined
    render(<BotConnectorsHostNotice bot={bot()} />)
    expect(
      screen.getByText(
        'Orca on box1 was built without Orca Cloud sign-in. Install Orca’s release build there to sign it in.'
      )
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Sign in on / })).toBeNull()
  })

  it('says nothing of an unconfigured build for a bot with no links', () => {
    host.account = { state: 'unconfigured' }
    host.connector = undefined
    const { container } = render(<BotConnectorsHostNotice bot={bot({ github: null })} />)
    expect(container.textContent).toBe('')
  })
})
