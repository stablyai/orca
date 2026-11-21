// @vitest-environment happy-dom

import { withBotConnectorRuntime } from '../../../lib/bot-connector-host-calls.test-fixture'
import { StrictMode } from 'react'
import {
  act,
  cleanup,
  fireEvent,
  render as renderUi,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'

const mocks = vi.hoisted(() => {
  const bots: Bot[] = []
  return { bots }
})
vi.mock('@/lib/bot-catalog', () => ({
  useBots: () => mocks.bots,
  readBots: () => mocks.bots,
  useHostBots: (hostId: string) => mocks.bots.filter((entry) => entry.hostId === hostId)
}))

import type * as BotHostPage from '@/lib/bot-host-page'

// Where Slack's page opens; a paired server's opens in Orca's browser.
const openBotHostPageOrSay = vi.hoisted(() => vi.fn())
vi.mock('@/lib/bot-host-page', async (actual) => {
  const real = await actual<typeof BotHostPage>()
  openBotHostPageOrSay.mockImplementation(real.openBotHostPageOrSay)
  return { ...real, openBotHostPageOrSay }
})

import { refreshBotSlack } from '@/lib/bot-slack-state'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { ORCA_CONNECTED, ORCA_SIGNED_OUT, orcaSignIn } from '../orca-sign-in.test-fixture'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import { BotSlackSetupDialog } from './BotSlackSetupDialog'
import { knownSlackTeam } from './slack-setup-teams'

// The installed step lists who can ask, whose Add asks first.
const render = (ui: React.ReactElement): ReturnType<typeof renderUi> =>
  renderUi(ui, { wrapper: ConfirmationDialogProvider })

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
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
  }
}

const api = {
  state: vi.fn(),
  saveGrant: vi.fn(),
  setUpApp: vi.fn(),
  openUrl: vi.fn()
}

function slackState(state: ConnectorBotSlackState): void {
  api.state.mockResolvedValue({ ok: true, value: state })
}

function openDialog(subject = bot()): void {
  render(<BotSlackSetupDialog bot={subject} open onOpenChange={() => {}} />)
}

beforeEach(() => {
  mocks.bots = []
  for (const fn of Object.values(api)) {
    fn.mockReset()
  }
  api.setUpApp.mockResolvedValue({
    ok: true,
    value: { appId: 'A1', authorizeUrl: 'https://slack.com/oauth/v2/authorize?x=1' }
  })
  Object.assign(window, {
    api: withBotConnectorRuntime({
      botSlack: { state: api.state, saveGrant: api.saveGrant, setUpApp: api.setUpApp },
      shell: { openUrl: api.openUrl }
    })
  })
})

const initialStore = useAppStore.getState()

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
  useAppStore.setState(initialStore, true)
})

describe('knownSlackTeam', () => {
  it('reuses the workspace of the most recently changed other bot in Slack', () => {
    const bots = [
      bot({ id: 'a', slack: { appId: 'A', teamId: 'T-old' }, updatedAt: 1 }),
      bot({ id: 'b', slack: { appId: 'B', teamId: 'T-new' }, updatedAt: 5 }),
      bot({ id: 'me', slack: { appId: 'C', teamId: 'T-mine' }, updatedAt: 9 })
    ]
    expect(knownSlackTeam(bots, 'me')).toBe('T-new')
    expect(knownSlackTeam([bot({ id: 'me' })], 'me')).toBeNull()
  })
})

describe('BotSlackSetupDialog', () => {
  it('asks the first bot in a workspace for a token, clears it on submit and opens Slack', async () => {
    slackState({ state: 'not_created' })
    api.saveGrant.mockResolvedValue({ ok: true, value: { teamId: 'T1' } })
    openDialog()

    const field = await screen.findByLabelText('Configuration refresh token')
    expect(field).toHaveProperty('type', 'password')
    fireEvent.change(field, { target: { value: ' xoxe-1-secret ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Slack app' }))

    expect(api.saveGrant).toHaveBeenCalledWith({ refreshToken: 'xoxe-1-secret' })
    await screen.findByText('Waiting for Slack…')
    expect(api.setUpApp).toHaveBeenCalledWith({ botId: 'bot-1', teamId: 'T1' })
    expect(api.openUrl).toHaveBeenCalledWith('https://slack.com/oauth/v2/authorize?x=1')
  })

  it('steps aside while Slack is open in Orca’s browser, and comes back once Slack saves', async () => {
    const returnUrl = 'https://connector.example/slack/oauth/callback'
    api.setUpApp.mockResolvedValue({
      ok: true,
      value: {
        appId: 'A1',
        authorizeUrl: `https://slack.com/oauth/v2/authorize?redirect_uri=${encodeURIComponent(returnUrl)}`
      }
    })
    openBotHostPageOrSay.mockClear()
    openBotHostPageOrSay.mockReturnValueOnce('orca-browser')
    slackState({ state: 'created', teamId: 'T1', appId: 'A1' })
    renderUi(
      <TooltipProvider>
        <BotSlackSetupDialog bot={bot()} open onOpenChange={() => {}} />
      </TooltipProvider>,
      { wrapper: ConfirmationDialogProvider }
    )
    const pill = { name: /Adding Scout to Slack/ }
    await screen.findByRole('status', pill)
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull()

    // Expand while Slack is still open: the same wait, not a second Slack page.
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    await screen.findByText('Waiting for Slack…')
    expect(openBotHostPageOrSay).toHaveBeenCalledTimes(1)

    // A read already out (the owner came back to Orca) when Slack saves may predate the save.
    let answerEarlierRead: (() => void) | undefined
    api.state.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerEarlierRead = () =>
            resolve({ ok: true, value: { state: 'created', teamId: 'T1', appId: 'A1' } })
        })
    )
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(answerEarlierRead).toBeTypeOf('function'))

    // Slack has saved by the time Orca's browser returns.
    slackState({
      state: 'installed',
      teamId: 'T1',
      appId: 'A1',
      botUserId: 'UB',
      installerUserId: 'U1'
    })
    act(() =>
      useAppStore.setState({
        browserPagesByWorkspace: {
          ws: [
            {
              id: 'p1',
              workspaceId: 'ws',
              worktreeId: 'wt',
              url: `${returnUrl}?code=c&state=s`,
              title: '',
              loading: false,
              faviconUrl: null,
              canGoBack: false,
              canGoForward: false,
              loadError: null,
              createdAt: 1
            }
          ]
        }
      })
    )
    await act(async () => answerEarlierRead?.())
    expect(await screen.findByText('Scout is in Slack')).toBeDefined()
  })

  it('keeps the token form with the cloud’s reason, and an empty field, when the grant fails', async () => {
    slackState({ state: 'not_created' })
    api.saveGrant.mockResolvedValue({ ok: false, error: 'grant_expired' })
    openDialog()

    const field = await screen.findByLabelText('Configuration refresh token')
    fireEvent.change(field, { target: { value: 'xoxe-1-old' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Slack app' }))

    await screen.findByText(/no longer accepts this workspace’s token/)
    expect(screen.getByLabelText('Configuration refresh token')).toHaveProperty('value', '')
    expect(api.setUpApp).not.toHaveBeenCalled()
  })

  it('never opens Slack after the dialog was dismissed', async () => {
    slackState({ state: 'not_created' })
    let answerGrant: (value: unknown) => void = () => {}
    api.saveGrant.mockReturnValue(new Promise((resolve) => (answerGrant = resolve)))
    openDialog()

    fireEvent.change(await screen.findByLabelText('Configuration refresh token'), {
      target: { value: 'xoxe-1-secret' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Slack app' }))
    cleanup()
    await act(async () => answerGrant({ ok: true, value: { teamId: 'T1' } }))
    await waitFor(() => expect(api.setUpApp).toHaveBeenCalled())
    expect(api.openUrl).not.toHaveBeenCalled()
  })

  it('sets up a later bot in the workspace another bot uses and opens Slack’s install page', async () => {
    slackState({ state: 'not_created' })
    mocks.bots = [bot({ id: 'other', slack: { appId: 'A0', teamId: 'T1' } })]
    openDialog()

    await screen.findByText('Waiting for Slack…')
    expect(api.setUpApp).toHaveBeenCalledWith({ botId: 'bot-1', teamId: 'T1' })
    expect(api.saveGrant).not.toHaveBeenCalled()
    expect(api.openUrl).toHaveBeenCalledWith('https://slack.com/oauth/v2/authorize?x=1')
  })

  it('opens Slack’s install page again for an app a removal kept', async () => {
    slackState({ state: 'created', teamId: 'T1', appId: 'A1' })
    openDialog()

    await screen.findByText('Waiting for Slack…')
    expect(api.setUpApp).toHaveBeenCalledWith({ botId: 'bot-1', teamId: 'T1' })
    expect(api.openUrl).toHaveBeenCalledOnce()
  })

  it('updates an out-of-date app and waits for the approval, not the old install', async () => {
    slackState({
      state: 'installed',
      teamId: 'T1',
      appId: 'A1',
      botUserId: 'UB',
      installerUserId: 'U1',
      updateNeeded: true
    })
    openDialog()

    await screen.findByText('Waiting for Slack…')
    expect(api.setUpApp).toHaveBeenCalledWith({ botId: 'bot-1', teamId: 'T1' })
    expect(api.openUrl).toHaveBeenCalledOnce()
  })

  it('updates an app that only predates optional permissions, and waits for them', async () => {
    slackState({
      state: 'installed',
      teamId: 'T1',
      appId: 'A1',
      botUserId: 'UB',
      installerUserId: 'U1',
      updateAvailable: true
    })
    openDialog()

    await screen.findByText('Waiting for Slack…')
    expect(api.setUpApp).toHaveBeenCalledWith({ botId: 'bot-1', teamId: 'T1' })
    expect(api.openUrl).toHaveBeenCalledOnce()
  })

  it('opens Slack once per open while the bot is re-read and the update still waits', async () => {
    slackState({
      state: 'installed',
      teamId: 'T1',
      appId: 'A1',
      botUserId: 'UB',
      installerUserId: 'U1',
      updateNeeded: true
    })
    const view = render(<BotSlackSetupDialog bot={bot()} open onOpenChange={() => {}} />)
    await screen.findByText('Waiting for Slack…')
    // Each refresh re-reads the bots list: the same bot, a new object, and Slack not done yet.
    for (let reread = 2; reread <= 5; reread++) {
      view.rerender(
        <BotSlackSetupDialog bot={bot({ updatedAt: reread })} open onOpenChange={() => {}} />
      )
      await act(async () => {})
    }
    expect(api.setUpApp).toHaveBeenCalledOnce()
    expect(api.openUrl).toHaveBeenCalledOnce()
  })

  it('opens Slack once when the dialog mounts twice, and never after it closed', async () => {
    slackState({ state: 'created', teamId: 'T1', appId: 'A1' })
    render(
      <StrictMode>
        <BotSlackSetupDialog bot={bot()} open onOpenChange={() => {}} />
      </StrictMode>
    )
    await screen.findByText('Waiting for Slack…')
    expect(api.openUrl).toHaveBeenCalledOnce()
    cleanup()

    let answer: (value: unknown) => void = () => {}
    api.setUpApp.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    api.openUrl.mockReset()
    openDialog()
    await waitFor(() => expect(api.setUpApp).toHaveBeenCalledTimes(3))
    cleanup()
    await act(async () =>
      answer({ ok: true, value: { appId: 'A1', authorizeUrl: 'https://slack.com/x' } })
    )
    expect(api.openUrl).not.toHaveBeenCalled()
  })

  it('turns to installed on its own once Slack finishes, through the shared poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    slackState({ state: 'not_created' })
    mocks.bots = [bot({ id: 'other', slack: { appId: 'A0', teamId: 'T1' } })]
    openDialog()
    slackState({ state: 'created', teamId: 'T1', appId: 'A1' })
    await screen.findByText('Waiting for Slack…')

    slackState({
      state: 'installed',
      teamId: 'T1',
      appId: 'A1',
      botUserId: 'U1',
      installerUserId: 'U2',
      installerName: 'Alice'
    })
    await act(() => vi.advanceTimersByTimeAsync(7_000))
    expect(screen.getByText('Scout is in Slack')).toBeDefined()
    // How to ask shows once it's in, as a Slack message from whoever installed it that mentions the
    // bot; who can ask is edited from the Slack connector's settings.
    const ask = screen.getByText('@Scout').closest('p')
    expect(ask?.textContent).toBe('@Scout summarize this thread')
    expect(ask?.parentElement?.textContent).toBe('Alicenow@Scout summarize this thread')
    vi.useRealTimers()
  })

  it('asks for a new token when the workspace’s grant expired', async () => {
    slackState({ state: 'not_created' })
    mocks.bots = [bot({ id: 'other', slack: { appId: 'A0', teamId: 'T1' } })]
    api.setUpApp.mockResolvedValue({ ok: false, error: 'grant_expired' })
    openDialog()

    expect(await screen.findByRole('button', { name: 'Reconnect Slack workspace' })).toBeDefined()
  })

  it.each([
    [{ state: 'created', teamId: 'T1', appId: 'A1' } as const, 'Install again'],
    [
      {
        state: 'installed',
        teamId: 'T1',
        appId: 'A1',
        botUserId: 'U1',
        installerUserId: 'U2'
      } as const,
      'Done'
    ],
    [{ state: 'grant_expired', teamId: 'T1' } as const, 'Reconnect Slack workspace']
  ])('opens on the step for the cloud’s %o', async (state, button) => {
    slackState(state)
    openDialog()
    expect(await screen.findByRole('button', { name: button })).toBeDefined()
  })

  it('shows the install once the shared state sees it, wherever it was read', async () => {
    slackState({ state: 'created', teamId: 'T1', appId: 'A1' })
    openDialog()
    await screen.findByText('Waiting for Slack…')

    slackState({
      state: 'installed',
      teamId: 'T1',
      appId: 'A1',
      botUserId: 'U1',
      installerUserId: 'U2'
    })
    await act(() => refreshBotSlack({ hostId: 'local', id: 'bot-1' }))
    expect(screen.getByText('Scout is in Slack')).toBeDefined()
  })

  it('sets up again only after the owner checked Slack for a half-made app', async () => {
    slackState({ state: 'uncertain', teamId: 'T1' })
    openDialog()

    const again = await screen.findByRole('button', { name: 'Set up again' })
    expect(again).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(again)
    await waitFor(() => expect(api.setUpApp).toHaveBeenCalledWith({ botId: 'bot-1', teamId: 'T1' }))
  })

  it('asks a signed-out owner to sign in before setup, then carries on to it', async () => {
    slackState({ state: 'not_created' })
    const connect = vi.fn(orcaSignIn())
    useAppStore.setState({
      orcaProfileAuthStatus: ORCA_SIGNED_OUT,
      connectCurrentOrcaProfile: connect
    })
    openDialog()
    expect(
      screen.getByText('Slack connects through Orca Cloud. Sign in to Orca to continue.')
    ).toBeDefined()
    expect(api.state).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('button', { name: 'Create Slack app' })).toBeDefined()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().activeView).not.toBe('settings')
  })

  it('asks again when the cloud says signed out, and sets up after signing in', async () => {
    api.state.mockResolvedValue({ ok: false, error: 'signed_out' })
    useAppStore.setState({
      orcaProfileAuthStatus: ORCA_CONNECTED,
      connectCurrentOrcaProfile: orcaSignIn(() => slackState({ state: 'not_created' }))
    })
    openDialog()
    expect(
      await screen.findByText('Slack connects through Orca Cloud. Sign in to Orca to continue.')
    ).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('button', { name: 'Create Slack app' })).toBeDefined()
  })
})
