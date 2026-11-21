// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type * as BotHostStatus from '@/lib/bot-host-status'

type Fake = ReturnType<typeof vi.fn>
const mocks = vi.hoisted(() => {
  const state: {
    bots: Bot[]
    hostEmail: string | null
    hosts: Record<string, Record<string, ReturnType<typeof vi.fn>>>
    open: ReturnType<typeof vi.fn>
    startHostSignIn: ReturnType<typeof vi.fn>
    /** The server's verified status as the sign-in action reads it; null leaves the real one. */
    hostStatus: null | { verified: boolean; approvesInBrowser: boolean }
    /** The server's own account as the sign-in action reads it, when a test sets one. */
    hostAccount: unknown
    refreshAccount: ReturnType<typeof vi.fn>
  } = {
    bots: [],
    hostEmail: 'm4air@example.test',
    hosts: {},
    open: vi.fn(),
    startHostSignIn: vi.fn(),
    hostStatus: null,
    hostAccount: undefined,
    refreshAccount: vi.fn()
  }
  return state
})
vi.mock('@/lib/bot-catalog', () => ({
  useBots: () => mocks.bots,
  readBots: () => mocks.bots,
  useHostBots: (hostId: string) => mocks.bots.filter((entry) => entry.hostId === hostId),
  // Sign in on <server> opens the bot's Connectors tab first, which keeps the wait in view.
  openBotHome: () => true
}))
vi.mock('@/lib/bot-connector-host-calls', () => ({
  botSlackCalls: (hostId: string) => mocks.hosts[hostId]
}))
vi.mock('@/lib/bot-host-orca-account', () => ({
  useBotHostOrcaAccount: () =>
    mocks.hostAccount !== undefined
      ? mocks.hostAccount
      : mocks.hostEmail
        ? { state: 'signed-in', email: mocks.hostEmail }
        : null,
  useBotHostOrcaAccountSettled: () => true,
  refreshBotHostOrcaAccount: mocks.refreshAccount,
  startBotHostSignIn: mocks.startHostSignIn
}))
vi.mock('@/lib/bot-host-page', () => ({ openBotHostPageOrSay: mocks.open }))
vi.mock('@/lib/bot-host-status', async (actual) => {
  const real = await actual<typeof BotHostStatus>()
  return {
    ...real,
    useBotHostVerified: (hostId: ExecutionHostId) =>
      mocks.hostStatus ? mocks.hostStatus.verified : real.useBotHostVerified(hostId),
    useBotHostHas: (hostId: ExecutionHostId, capability: string) =>
      mocks.hostStatus && capability === ORCA_ACCOUNT_APPROVE_IN_BROWSER_RUNTIME_CAPABILITY
        ? mocks.hostStatus.approvesInBrowser
        : real.useBotHostHas(hostId, capability)
  }
})

import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import { refreshBotSlack } from '@/lib/bot-slack-state'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { useAppStore } from '@/store'
import { ORCA_CONNECTED } from '../orca-sign-in.test-fixture'
import { BotSlackSetupDialog } from './BotSlackSetupDialog'
import { ORCA_ACCOUNT_APPROVE_IN_BROWSER_RUNTIME_CAPABILITY } from '../../../../../shared/orca-account-runtime-capabilities'

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
  mocks.hostStatus = null
  mocks.hostAccount = undefined
  mocks.refreshAccount.mockReset().mockResolvedValue(undefined)
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
    // Sign in on <server> shows only for a verified server that takes it, its sign-in read.
    mocks.hostStatus = { verified: true, approvesInBrowser: true }
    mocks.hostAccount = { state: 'signed-out', storage: { kind: 'os-keychain' } }
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

  it('puts this desktop’s token first when the server’s lapsed, with the paste behind a disclosure', async () => {
    serverState({ state: 'grant_expired', teamId: 'T1' })
    mocks.hosts[SERVER].handOff.mockResolvedValue(ok({ code: 'one-time', expiresAt: 1 }))
    redeem.mockResolvedValue(ok({ appId: 'A1', authorizeUrl: AUTHORIZE }))
    openDialog()

    const use = await screen.findByRole('button', { name: 'Use it' })
    // A stray Enter must not spend this desktop's token.
    expect(document.activeElement).not.toBe(use)
    const field = screen.getByLabelText('Configuration refresh token')
    expect(field.closest('[hidden]')).not.toBeNull()
    const disclosure = screen.getByRole('button', { name: /Paste a token instead/ })
    fireEvent.click(disclosure)
    expect(field.closest('[hidden]')).toBeNull()
    expect(document.activeElement).toBe(field)
    // A token typed before closing it is still there on reopening.
    fireEvent.change(field, { target: { value: 'xoxe-typed' } })
    fireEvent.click(disclosure)
    fireEvent.click(disclosure)
    expect(screen.getByLabelText('Configuration refresh token')).toHaveProperty(
      'value',
      'xoxe-typed'
    )

    fireEvent.click(use)
    await screen.findByRole('button', { name: 'Approve in Slack' })
    expect(mocks.hosts[SERVER].handOff).toHaveBeenCalledWith({ botId: 'bot-1', teamId: 'T1' })
    expect(redeem).toHaveBeenCalledWith({ code: 'one-time' })
    expect(mocks.hosts[SERVER].saveGrant).not.toHaveBeenCalled()
  })

  it('saves a token pasted beside the offer on the server, and a refused one comes back open with focus on the field', async () => {
    serverState({ state: 'grant_expired', teamId: 'T1' })
    mocks.hosts[SERVER].saveGrant.mockResolvedValue({ ok: false, error: 'invalid_grant' })
    openDialog()

    fireEvent.click(await screen.findByRole('button', { name: /Paste a token instead/ }))
    fireEvent.change(screen.getByLabelText('Configuration refresh token'), {
      target: { value: 'xoxe-1-new' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))

    await waitFor(() =>
      expect(mocks.hosts[SERVER].saveGrant).toHaveBeenCalledWith({ refreshToken: 'xoxe-1-new' })
    )
    expect(mocks.hosts.local.saveGrant).not.toHaveBeenCalled()
    const field = await screen.findByLabelText('Configuration refresh token')
    await waitFor(() => expect(document.activeElement).toBe(field))
    expect(field.closest('[hidden]')).toBeNull()
    expect(field.getAttribute('aria-invalid')).toBe('true')
  })

  it('focuses the token field when there is no token to offer', async () => {
    mocks.bots = []
    serverState({ state: 'grant_expired', teamId: 'T1' })
    openDialog()

    const field = await screen.findByLabelText('Configuration refresh token')
    expect(document.activeElement).toBe(field)
    expect(screen.queryByRole('button', { name: 'Use it' })).toBeNull()
  })

  it('keeps a token typed into the paste-only step, in view, when this desktop’s offer arrives late', async () => {
    serverState({ state: 'grant_expired', teamId: 'T1' })
    // This desktop's own account isn't read yet, so there is nothing to offer at first.
    const signedIn = useAppStore.getState().orcaProfileAuthStatus
    useAppStore.setState({ orcaProfileAuthStatus: { ...ORCA_CONNECTED, cloud: undefined } })
    openDialog()

    fireEvent.change(await screen.findByLabelText('Configuration refresh token'), {
      target: { value: 'xoxe-typed' }
    })
    act(() => useAppStore.setState({ orcaProfileAuthStatus: signedIn }))

    await screen.findByRole('button', { name: 'Use it' })
    const field = screen.getByLabelText('Configuration refresh token')
    expect(field).toHaveProperty('value', 'xoxe-typed')
    expect(field.closest('[hidden]')).toBeNull()
    expect(
      screen.getByRole('button', { name: /Paste a token instead/ }).getAttribute('aria-expanded')
    ).toBe('true')
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

  it("sends a signed-out server to the server's own sign-in, never this computer's", async () => {
    mocks.hostStatus = { verified: true, approvesInBrowser: true }
    mocks.hosts[SERVER].state.mockResolvedValue({ ok: false, error: 'signed_out' })
    const connect = vi.fn()
    useAppStore.setState({ connectCurrentOrcaProfile: connect })
    mocks.startHostSignIn.mockReset().mockResolvedValue(undefined)
    openDialog()

    const signIn = await screen.findByRole('button', { name: /^Sign in on / })
    expect(screen.getByText(/^Sign .+ in to Orca Cloud to connect Slack\.$/)).toBeDefined()
    expect(
      screen.queryByText('Slack connects through Orca Cloud. Sign in to Orca to continue.')
    ).toBeNull()
    fireEvent.click(signIn)
    expect(mocks.startHostSignIn).toHaveBeenCalledWith(
      SERVER,
      expect.objectContaining({ id: 'bot-1' })
    )
    expect(connect).not.toHaveBeenCalled()
  })

  it('asks to update an older server first, and offers nothing until the server is verified', async () => {
    mocks.hosts[SERVER].state.mockResolvedValue({ ok: false, error: 'signed_out' })
    mocks.hostStatus = { verified: true, approvesInBrowser: false }
    openDialog()
    expect(
      await screen.findByText(/^Update Orca on .+, then sign it in from here\.$/)
    ).toBeDefined()
    expect(screen.queryByRole('button', { name: /^Sign in on / })).toBeNull()
    cleanup()

    mocks.hostStatus = { verified: false, approvesInBrowser: true }
    openDialog()
    await screen.findByText(/^Sign .+ in to Orca Cloud to connect Slack\.$/)
    expect(screen.queryByRole('button', { name: /^Sign in on / })).toBeNull()
    expect(screen.queryByText(/^Update Orca on /)).toBeNull()
  })

  it.each([
    [
      'a build without Orca Cloud sign-in',
      { state: 'unconfigured', storage: { kind: 'os-keychain' } },
      /^Orca on .+ was built without Orca Cloud sign-in\. Install Orca’s release build there to sign it in\.$/
    ],
    [
      'a server that can’t save a sign-in',
      { state: 'signed-out', storage: { kind: 'refused', reason: 'no keychain' } },
      /^.+ can’t save an Orca sign-in: no keychain$/
    ],
    ['an account it couldn’t read', null, /^Couldn’t read .+’s Orca sign-in\.$/]
  ])('offers no sign-in that would fail, and says why, for %s', async (_case, account, says) => {
    mocks.hosts[SERVER].state.mockResolvedValue({ ok: false, error: 'signed_out' })
    mocks.hostStatus = { verified: true, approvesInBrowser: true }
    mocks.hostAccount = account
    openDialog()
    expect(await screen.findByText(says)).toBeDefined()
    expect(screen.queryByRole('button', { name: /^Sign in on / })).toBeNull()
    if (account === null) {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      expect(mocks.refreshAccount).toHaveBeenCalledWith(SERVER)
    }
  })
})
