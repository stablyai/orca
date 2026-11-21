// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { SlackWorkspacesSettings } from './SlackWorkspacesSettings'
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
// This computer's browser, where Slack's pages open for a bot on any computer.
const openUrl = vi.fn()

function serverState(state: ConnectorBotSlackState): void {
  mocks.hosts[SERVER].state.mockResolvedValue(ok(state))
}

function openDialog(overrides: Partial<Bot> = {}, teamId?: string): void {
  render(
    <TooltipProvider>
      <BotSlackSetupDialog bot={bot(overrides)} teamId={teamId} open onOpenChange={() => {}} />
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
  openUrl.mockReset().mockResolvedValue(undefined)
  Object.assign(window, {
    api: { slackHandOff: { redeem }, ui: { writeClipboardText }, shell: { openUrl } }
  })
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

  it("opens Slack's token page in this computer's browser, never the server's or another bot's", async () => {
    // The server's own token lapsed for the workspace this bot is already in: no hand-off, the token
    // form only, and the new token goes to the server's account.
    mocks.bots.push(bot({ id: 'other', slack: { appId: 'A9', teamId: 'T1' } }))
    serverState({ state: 'grant_expired', teamId: 'T1' })
    mocks.hosts[SERVER].saveGrant.mockResolvedValue(ok({ teamId: 'T1' }))
    mocks.hosts[SERVER].setUpApp.mockResolvedValue(
      ok({ appId: 'A1', authorizeUrl: AUTHORIZE, expiresAt: NOW + 60_000 })
    )
    openDialog({ slack: { appId: 'A1', teamId: 'T1' } }, 'T1')

    // The bot's own app is in T1, so no hand-off: the short paste form leads, with no Use it in any form.
    await screen.findByText('Paste a new token to reconnect.')
    expect(screen.queryByRole('button', { name: /^Use it/ })).toBeNull()
    expect(screen.queryByText(/already has a token for/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open Slack app settings' }))
    // This computer's browser, never the server's, whose page opens in one of its bots' workspaces.
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://api.slack.com/apps'))
    expect(openUrl).toHaveBeenCalledTimes(1)
    expect(mocks.open).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Configuration refresh token'), {
      target: { value: 'xoxe-1-new' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await screen.findByRole('button', { name: 'Approve in Slack' })
    expect(mocks.hosts[SERVER].saveGrant).toHaveBeenCalledWith({ refreshToken: 'xoxe-1-new' })
    expect(mocks.hosts.local.saveGrant).not.toHaveBeenCalled()
  })

  it("opens Approve in Slack in this computer's browser, where the token was made", async () => {
    mocks.bots.push(bot({ id: 'other', slack: { appId: 'A9', teamId: 'T1' } }))
    serverState({ state: 'not_created' })
    mocks.hosts[SERVER].setUpApp.mockResolvedValue(
      ok({ appId: 'A1', authorizeUrl: AUTHORIZE, expiresAt: NOW + 60_000 })
    )
    openDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Approve in Slack' }))
    expect(await screen.findByText('Waiting for Slack…')).toBeTruthy()
    expect(openUrl).toHaveBeenCalledTimes(1)
    expect(openUrl).toHaveBeenCalledWith(AUTHORIZE)
    expect(mocks.open).not.toHaveBeenCalled()

    // Approved in this computer's browser: the server's cloud state is what the wait reads.
    serverState({
      state: 'installed',
      teamId: 'T1',
      appId: 'A1',
      botUserId: 'UB',
      installerUserId: 'U1',
      teamName: 'Acme'
    })
    await act(() => refreshBotSlack({ hostId: SERVER, id: 'bot-1' }))
    expect(await screen.findByText('Scout is in Slack')).toBeTruthy()
  })

  it('refuses an approval link that is not Slack’s, for Approve and Copy link alike', async () => {
    mocks.bots.push(bot({ id: 'other', slack: { appId: 'A9', teamId: 'T1' } }))
    serverState({ state: 'not_created' })
    mocks.hosts[SERVER].setUpApp.mockResolvedValue(
      ok({
        appId: 'A1',
        authorizeUrl: 'https://evil.test/oauth/v2/authorize',
        expiresAt: NOW + 60_000
      })
    )
    openDialog()

    expect(
      await screen.findByText('This approval link isn’t Slack’s, so Orca didn’t open it.')
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve in Slack' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(mocks.open).not.toHaveBeenCalled()
    expect(openUrl).not.toHaveBeenCalled()
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('stays on Approve in Slack when this computer’s browser could not be opened', async () => {
    mocks.bots.push(bot({ id: 'other', slack: { appId: 'A9', teamId: 'T1' } }))
    serverState({ state: 'not_created' })
    mocks.hosts[SERVER].setUpApp.mockResolvedValue(
      ok({ appId: 'A1', authorizeUrl: AUTHORIZE, expiresAt: NOW + 60_000 })
    )
    openUrl.mockRejectedValue(new Error('no default browser'))
    openDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Approve in Slack' }))
    await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1))
    await act(async () => {})
    // Not waiting on a page that never opened: Approve again, or Copy link, are still here.
    expect(screen.queryByText('Waiting for Slack…')).toBeNull()
    expect(screen.getByRole('button', { name: 'Approve in Slack' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy()
    // The failed launch let go of its page: asking again opens it again.
    openUrl.mockResolvedValue(undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Approve in Slack' }))
    expect(await screen.findByText('Waiting for Slack…')).toBeTruthy()
    expect(openUrl).toHaveBeenCalledTimes(2)
  })

  it('launches Approve once, and a late launch never undoes a later Copy link', async () => {
    mocks.bots.push(bot({ id: 'other', slack: { appId: 'A9', teamId: 'T1' } }))
    serverState({ state: 'not_created' })
    mocks.hosts[SERVER].setUpApp.mockResolvedValue(
      ok({ appId: 'A1', authorizeUrl: AUTHORIZE, expiresAt: NOW + 60_000 })
    )
    let launched: () => void = () => {}
    openUrl.mockReturnValue(new Promise<void>((resolve) => (launched = resolve)))
    openDialog()

    const approve = await screen.findByRole('button', { name: 'Approve in Slack' })
    fireEvent.click(approve)
    fireEvent.click(approve)
    expect(openUrl).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await screen.findByText('Link copied')
    // The browser answers only now: the copied link's wait stands.
    await act(async () => launched())
    expect(screen.getByText('Link copied')).toBeTruthy()
    expect(openUrl).toHaveBeenCalledTimes(1)
  })

  describe('a launch that answers late', () => {
    const SECOND = 'https://slack.com/oauth/v2/authorize?x=second'
    let launches: (() => void)[] = []
    beforeEach(() => {
      launches = []
      mocks.bots.push(bot({ id: 'other', slack: { appId: 'A9', teamId: 'T1' } }))
      serverState({ state: 'not_created' })
      mocks.hosts[SERVER].setUpApp
        .mockResolvedValueOnce(
          ok({ appId: 'A1', authorizeUrl: AUTHORIZE, expiresAt: NOW + 60_000 })
        )
        .mockResolvedValueOnce(ok({ appId: 'A1', authorizeUrl: SECOND, expiresAt: NOW + 60_000 }))
      openUrl.mockImplementation(() => new Promise<void>((resolve) => launches.push(resolve)))
    })
    const approveFirstThenInstallAgain = async (): Promise<void> => {
      fireEvent.click(await screen.findByRole('button', { name: 'Approve in Slack' }))
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Install again' }))
      await screen.findByRole('button', { name: 'Approve in Slack' })
    }

    it('leaves Install again’s new link in place, and Copy link copies it', async () => {
      openDialog()
      await approveFirstThenInstallAgain()
      await act(async () => launches[0]())
      expect(screen.queryByText('Waiting for Slack…')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
      await screen.findByText('Link copied')
      expect(writeClipboardText).toHaveBeenLastCalledWith(SECOND)
    })

    it('launches a second Approve only once, even after the first answers', async () => {
      openDialog()
      await approveFirstThenInstallAgain()
      const approve = screen.getByRole('button', { name: 'Approve in Slack' })
      fireEvent.click(approve)
      await act(async () => launches[0]())
      fireEvent.click(approve)
      expect(openUrl).toHaveBeenCalledTimes(2)
      expect(openUrl).toHaveBeenLastCalledWith(SECOND)
    })

    it('lets a dialog opened again set up afresh when the old launch answers while closed', async () => {
      openDialog()
      fireEvent.click(await screen.findByRole('button', { name: 'Approve in Slack' }))
      cleanup()
      // The browser answers with no dialog open; the server now has the app made.
      await act(async () => launches[0]())
      serverState({ state: 'created', teamId: 'T1', appId: 'A1' })
      openDialog()

      await screen.findByRole('button', { name: 'Approve in Slack' })
      expect(mocks.hosts[SERVER].setUpApp).toHaveBeenCalledTimes(2)
      expect(screen.queryByText('Waiting for Slack…')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
      await screen.findByText('Link copied')
      expect(writeClipboardText).toHaveBeenLastCalledWith(SECOND)
    })

    const installAgain = async (): Promise<void> => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Install again' }))
      await screen.findByRole('button', { name: 'Approve in Slack' })
    }

    it('joins a page still opening when Install again brings it back, and waits once it opens', async () => {
      // Install again can answer with the same approval link.
      mocks.hosts[SERVER].setUpApp
        .mockReset()
        .mockResolvedValue(ok({ appId: 'A1', authorizeUrl: AUTHORIZE, expiresAt: NOW + 60_000 }))
      openDialog()
      await approveFirstThenInstallAgain()
      fireEvent.click(screen.getByRole('button', { name: 'Approve in Slack' }))
      expect(openUrl).toHaveBeenCalledTimes(1)
      // The one launch answers for the Approve asked last: the dialog waits, Copy has its link.
      await act(async () => launches[0]())
      expect(await screen.findByText('Waiting for Slack…')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
      await screen.findByText('Link copied')
      expect(writeClipboardText).toHaveBeenLastCalledWith(AUTHORIZE)
      expect(openUrl).toHaveBeenCalledTimes(1)
    })

    it('keeps one launch per page across A, B and A again, and A answering keeps B’s', async () => {
      mocks.hosts[SERVER].setUpApp
        .mockResolvedValueOnce(
          ok({ appId: 'A1', authorizeUrl: AUTHORIZE, expiresAt: NOW + 60_000 })
        )
        .mockResolvedValueOnce(ok({ appId: 'A1', authorizeUrl: SECOND, expiresAt: NOW + 60_000 }))
      openDialog()
      await approveFirstThenInstallAgain()
      fireEvent.click(screen.getByRole('button', { name: 'Approve in Slack' }))
      await installAgain()
      fireEvent.click(screen.getByRole('button', { name: 'Approve in Slack' }))
      expect(openUrl.mock.calls).toEqual([[AUTHORIZE], [SECOND]])
      await act(async () => launches[0]())
      await screen.findByText('Waiting for Slack…')
      fireEvent.click(await screen.findByRole('button', { name: 'Install again' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Approve in Slack' }))
      expect(openUrl.mock.calls).toEqual([[AUTHORIZE], [SECOND]])
    })

    it('opens a page again in a dialog opened again while the old one was still opening', async () => {
      openDialog()
      fireEvent.click(await screen.findByRole('button', { name: 'Approve in Slack' }))
      cleanup()
      openDialog()
      fireEvent.click(await screen.findByRole('button', { name: 'Approve in Slack' }))
      expect(openUrl).toHaveBeenCalledTimes(2)
    })

    it('keeps Link copied when Copy link and the launch land together', async () => {
      openDialog()
      fireEvent.click(await screen.findByRole('button', { name: 'Approve in Slack' }))
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
        launches[0]()
      })
      expect(screen.getByText('Link copied')).toBeTruthy()
      expect(writeClipboardText).toHaveBeenCalledWith(AUTHORIZE)
    })
  })

  it('keeps a reconnect to its workspace when the pasted token is for another one', async () => {
    serverState({ state: 'grant_expired', teamId: 'T1' })
    mocks.hostEmail = 'me@example.test'
    mocks.hosts[SERVER].saveGrant.mockResolvedValue(ok({ teamId: 'T2' }))
    openDialog()

    fireEvent.change(await screen.findByLabelText('Configuration refresh token'), {
      target: { value: 'xoxe-1-other' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(
      await screen.findByText(
        'That token is for another workspace. Orca keeps it for that workspace.'
      )
    ).toBeTruthy()
    expect(mocks.hosts[SERVER].saveGrant).toHaveBeenCalledWith({ refreshToken: 'xoxe-1-other' })
    expect(mocks.hosts[SERVER].setUpApp).not.toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'T2' })
    )
  })

  it('keeps this desktop’s own reconnect to its workspace when the pasted token is for another', async () => {
    serverState({ state: 'not_created' })
    mocks.hosts[SERVER].handOff.mockResolvedValue(ok({ code: 'one-time', expiresAt: 1 }))
    // This desktop's own token lapsed too: its reconnect is for T1, the hand-off's workspace.
    redeem.mockResolvedValue({ ok: false, error: 'grant_expired' })
    mocks.hosts.local.saveGrant.mockResolvedValue(ok({ teamId: 'T2' }))
    openDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Use it →' }))
    fireEvent.change(await screen.findByLabelText('Configuration refresh token'), {
      target: { value: 'xoxe-1-other' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(
      await screen.findByText(
        'That token is for another workspace. Orca keeps it for that workspace.'
      )
    ).toBeTruthy()
    expect(mocks.hosts.local.saveGrant).toHaveBeenCalledWith({ refreshToken: 'xoxe-1-other' })
    expect(mocks.hosts[SERVER].handOff).toHaveBeenCalledTimes(1)
    expect(mocks.hosts[SERVER].saveGrant).not.toHaveBeenCalled()
  })

  it("reconnects a server's workspace from Settings with Slack's page in this computer's browser", async () => {
    mocks.bots = [bot({ id: 'other', slack: { appId: 'A9', teamId: 'T1' } })]
    serverState({ state: 'not_created' })
    mocks.hosts[SERVER].saveGrant.mockResolvedValue(ok({ teamId: 'T1' }))
    render(
      <TooltipProvider>
        <SlackWorkspacesSettings
          hostId={SERVER}
          botHostIds={[SERVER]}
          account="m4air@example.test"
        />
      </TooltipProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Get config token' }))
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://api.slack.com/apps'))
    expect(mocks.open).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Configuration refresh token'), {
      target: { value: 'xoxe-1-new' }
    })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reconnect' }))
    await waitFor(() =>
      expect(mocks.hosts[SERVER].saveGrant).toHaveBeenCalledWith({ refreshToken: 'xoxe-1-new' })
    )
  })

  it('puts this desktop’s token first when the server’s lapsed, with the paste behind a disclosure', async () => {
    serverState({ state: 'grant_expired', teamId: 'T1' })
    mocks.hosts[SERVER].handOff.mockResolvedValue(ok({ code: 'one-time', expiresAt: 1 }))
    redeem.mockResolvedValue(ok({ appId: 'A1', authorizeUrl: AUTHORIZE }))
    openDialog()

    const use = await screen.findByRole('button', { name: 'Use it' })
    // A credential hand-off: never focused on open, so Enter can't spend this account's token unseen.
    expect(document.activeElement).not.toBe(use)
    // Whose token, and into which workspace, before anything is spent.
    fireEvent.focusIn(screen.getByRole('button', { name: 'About Slack tokens' }))
    expect(
      (
        await screen.findAllByText(
          'Use it sets up this bot’s Slack app in Acme with me@example.test’s token. m4 only gets this bot’s app.',
          { exact: false }
        )
      ).length
    ).toBeGreaterThan(0)
    expect(screen.queryByLabelText('Configuration refresh token')).toBeNull()
    // Open, the paste form's Cancel · Reconnect is the only footer: Use it steps aside.
    fireEvent.click(screen.getByRole('button', { name: /Paste a token instead/ }))
    expect(screen.getByLabelText('Configuration refresh token')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Use it' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Reconnect' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: /Paste a token instead/ }))

    fireEvent.click(await screen.findByRole('button', { name: 'Use it' }))
    await screen.findByRole('button', { name: 'Approve in Slack' })
    expect(mocks.hosts[SERVER].handOff).toHaveBeenCalledWith({ botId: 'bot-1', teamId: 'T1' })
    expect(redeem).toHaveBeenCalledWith({ code: 'one-time' })
    expect(mocks.hosts[SERVER].saveGrant).not.toHaveBeenCalled()
  })

  it('falls back to the paste form when Use it fails, never a dead end', async () => {
    serverState({ state: 'grant_expired', teamId: 'T1' })
    mocks.hosts[SERVER].handOff.mockResolvedValue(ok({ code: 'one-time', expiresAt: 1 }))
    redeem.mockResolvedValue({ ok: false, error: 'cloud_error' })
    openDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Use it' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    // Back on the reconnect step: Use it again, or paste a token.
    await screen.findByRole('button', { name: 'Use it' })
    fireEvent.click(screen.getByRole('button', { name: /Paste a token instead/ }))
    expect(screen.getByLabelText('Configuration refresh token')).toBeTruthy()
    expect(mocks.hosts[SERVER].handOff).toHaveBeenCalledTimes(1)
    expect(mocks.hosts[SERVER].saveGrant).not.toHaveBeenCalled()
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
