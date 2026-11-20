// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

type Fake = ReturnType<typeof vi.fn>
const mocks = vi.hoisted(() => {
  const state: {
    bots: Bot[]
    hostEmail: string | null
    hosts: Record<string, Record<string, ReturnType<typeof vi.fn>>>
    open: ReturnType<typeof vi.fn>
  } = { bots: [], hostEmail: 'm4air@example.test', hosts: {}, open: vi.fn() }
  return state
})
vi.mock('@/lib/bot-catalog', () => ({
  useBots: () => mocks.bots,
  readBots: () => mocks.bots,
  useHostBots: (hostId: string) => mocks.bots.filter((entry) => entry.hostId === hostId)
}))
vi.mock('@/lib/bot-connector-host-calls', () => ({
  botSlackCalls: (hostId: string) => mocks.hosts[hostId]
}))
vi.mock('@/lib/bot-host-orca-account', () => ({
  useBotHostOrcaAccount: () =>
    mocks.hostEmail ? { state: 'signed-in', email: mocks.hostEmail } : null
}))
vi.mock('@/lib/bot-host-page', () => ({ openBotHostPageOrSay: mocks.open }))

import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import { refreshBotSlack } from '@/lib/bot-slack-state'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { useAppStore } from '@/store'
import { ORCA_CONNECTED } from '../orca-sign-in.test-fixture'
import { BotSlackSetupDialog } from './BotSlackSetupDialog'

const SERVER: ExecutionHostId = 'runtime:m4'
const NOW = 1_800_000_000_000
const AUTHORIZE = 'https://slack.com/oauth/v2/authorize?x=handed'

function bot(overrides: Partial<Bot> = {}, hostId: ExecutionHostId = SERVER): Bot {
  return stampBotHost(hostId, {
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
    members: [],
    slack: null,
    chatSessionId: null,
    linear: null,
    github: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  })
}

const ok = (value: unknown) => ({ ok: true, value })
const host = (): Record<string, Fake> => ({
  state: vi.fn(),
  saveGrant: vi.fn(),
  setUpApp: vi.fn(),
  handOff: vi.fn(),
  adoptApp: vi.fn().mockResolvedValue(ok(undefined))
})
const redeem = vi.fn()
const writeClipboardText = vi.fn()

function serverState(state: ConnectorBotSlackState): void {
  mocks.hosts[SERVER].state.mockResolvedValue(ok(state))
}

function openDialog(): void {
  render(
    <TooltipProvider>
      <BotSlackSetupDialog bot={bot()} open onOpenChange={() => {}} />
    </TooltipProvider>,
    { wrapper: ConfirmationDialogProvider }
  )
}

const initialStore = useAppStore.getState()

beforeEach(() => {
  // Only the clock is fixed; timers stay real for the dialog's async reads.
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  mocks.hosts = { [SERVER]: host(), local: host() }
  // This desktop's own bot in Acme names the workspace.
  mocks.hosts.local.state.mockResolvedValue(
    ok({
      state: 'installed',
      teamId: 'T1',
      appId: 'A0',
      botUserId: 'UB',
      installerUserId: 'U1',
      teamName: 'Acme'
    })
  )
  mocks.bots = [bot({ id: 'mine', slack: { appId: 'A0', teamId: 'T1' } }, 'local')]
  mocks.hostEmail = 'm4air@example.test'
  mocks.open.mockReset().mockReturnValue('orca-browser')
  redeem.mockReset()
  writeClipboardText.mockReset().mockResolvedValue(undefined)
  Object.assign(window, { api: { slackHandOff: { redeem }, ui: { writeClipboardText } } })
  useAppStore.setState({
    orcaProfileAuthStatus: {
      ...ORCA_CONNECTED,
      cloud: { cloudProfileId: 'c', userId: 'u', email: 'me@example.test', linkedAt: 1 }
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  Reflect.deleteProperty(window, 'api')
  useAppStore.setState(initialStore, true)
})

describe('BotSlackSetupDialog on a paired computer', () => {
  it('signs the server in, not this desktop, when the server is signed out', async () => {
    mocks.hosts[SERVER].state.mockResolvedValue({ ok: false, error: 'signed_out' })
    openDialog()

    await screen.findByRole('button', { name: /^Sign in on / })
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
  })

  it('copies the approval link without opening Slack and shows a wrong-installer failure', async () => {
    mocks.bots.push(bot({ id: 'other', slack: { appId: 'A9', teamId: 'T1' } }))
    serverState({ state: 'not_created' })
    mocks.hosts[SERVER].setUpApp.mockResolvedValue(
      ok({ appId: 'A1', authorizeUrl: AUTHORIZE, expiresAt: NOW + 60_000 })
    )
    openDialog()

    await screen.findByRole('button', { name: 'Approve in Slack' })
    expect(mocks.open).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await screen.findByText('Link copied')
    expect(writeClipboardText).toHaveBeenCalledWith(AUTHORIZE)
    expect(screen.getByText('Waiting for Slack…')).toBeTruthy()
    expect(mocks.open).not.toHaveBeenCalled()

    serverState({ state: 'created', teamId: 'T1', appId: 'A1', oauthFailure: 'other_user' })
    await act(() => refreshBotSlack({ hostId: SERVER, id: 'bot-1' }))
    expect(await screen.findByText(/Another Slack account approved it/)).toBeTruthy()
  })

  it('creates the app with this desktop’s own account from the hand-off line, never the server’s', async () => {
    serverState({ state: 'not_created' })
    mocks.hosts[SERVER].handOff.mockResolvedValue(ok({ code: 'one-time', expiresAt: 1 }))
    redeem.mockResolvedValue(ok({ appId: 'A1', authorizeUrl: AUTHORIZE }))
    openDialog()

    await screen.findByText(
      /signed in to Orca as me@example\.test, which already has a token for Acme\./
    )
    fireEvent.click(screen.getByRole('button', { name: 'Use it →' }))

    await screen.findByRole('button', { name: 'Approve in Slack' })
    expect(mocks.hosts[SERVER].handOff).toHaveBeenCalledWith({ botId: 'bot-1', teamId: 'T1' })
    expect(redeem).toHaveBeenCalledWith({ code: 'one-time' })
    expect(mocks.hosts[SERVER].adoptApp).toHaveBeenCalledWith({ botId: 'bot-1', teamId: 'T1' })
    expect(mocks.hosts[SERVER].saveGrant).not.toHaveBeenCalled()
    expect(mocks.hosts[SERVER].setUpApp).not.toHaveBeenCalled()
  })

  it('offers no hand-off when the server is signed in to this desktop’s own account', async () => {
    mocks.hostEmail = 'me@example.test'
    serverState({ state: 'not_created' })
    openDialog()

    await screen.findByLabelText('Configuration refresh token')
    expect(screen.queryByRole('button', { name: 'Use it →' })).toBeNull()
  })

  it('offers no hand-off in a paired web client, which cannot redeem', async () => {
    Reflect.set(globalThis, '__ORCA_WEB_CLIENT__', true)
    try {
      serverState({ state: 'not_created' })
      openDialog()
      await screen.findByLabelText('Configuration refresh token')
      expect(screen.queryByRole('button', { name: 'Use it →' })).toBeNull()
    } finally {
      Reflect.deleteProperty(globalThis, '__ORCA_WEB_CLIENT__')
    }
  })

  it('ends in an error, not a stuck spinner, when the redeem call rejects', async () => {
    serverState({ state: 'not_created' })
    mocks.hosts[SERVER].handOff.mockResolvedValue(ok({ code: 'one-time', expiresAt: 1 }))
    redeem.mockRejectedValue(new Error('bridge gone'))
    openDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Use it →' }))
    await screen.findByRole('button', { name: 'Try again' })
    expect(screen.queryByText('Setting up your Slack app…')).toBeNull()
  })

  it('goes back to the paste form when the cloud says the server is on this account', async () => {
    serverState({ state: 'not_created' })
    mocks.hosts[SERVER].handOff.mockResolvedValue(ok({ code: 'one-time', expiresAt: 1 }))
    redeem.mockResolvedValue({ ok: false, error: 'same_account' })
    openDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Use it →' }))
    await waitFor(() => expect(redeem).toHaveBeenCalled())
    expect(await screen.findByLabelText('Configuration refresh token')).toBeTruthy()
    expect(mocks.hosts[SERVER].adoptApp).not.toHaveBeenCalled()
  })

  it('says the link expired once its time passes, and Get a new link sets up again', async () => {
    serverState({ state: 'created', teamId: 'T1', appId: 'A1' })
    mocks.hosts[SERVER].setUpApp.mockResolvedValue(
      ok({ appId: 'A1', authorizeUrl: AUTHORIZE, expiresAt: NOW - 1 })
    )
    openDialog()

    await screen.findByText('The install link expired.')
    fireEvent.click(screen.getByRole('button', { name: 'Get a new link' }))
    await waitFor(() => expect(mocks.hosts[SERVER].setUpApp).toHaveBeenCalledTimes(2))
  })
})
