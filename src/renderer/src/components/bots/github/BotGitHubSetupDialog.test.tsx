// @vitest-environment happy-dom

import { withBotConnectorRuntime } from '../../../lib/bot-connector-host-calls.test-fixture'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import { awaitGitHubChange, readGitHubAwait, stopAwaitingGitHub } from '@/lib/bot-github-state'
import {
  openGitHubInstall,
  readGitHubInstallRecord,
  resetGitHubInstallForTests
} from '@/lib/bot-github-install-record'
import { cancelConnectorConnect, startConnectorConnect } from '@/lib/connector-connect-state'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorGitHubState } from '../../../../../shared/connector-bot-github-contract'
const mocks = vi.hoisted(() => {
  const listed: Bot[] = []
  return { updateBot: vi.fn(), readBots: vi.fn((): Bot[] => []), listed }
})
vi.mock('@/lib/bot-catalog', () => ({
  updateBot: mocks.updateBot,
  readBots: mocks.readBots,
  useBots: () => mocks.listed
}))
const openAppHttpLink = vi.hoisted(() => vi.fn())
vi.mock('@/lib/browser/navigation/app-http-link-open', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  openAppHttpLink
}))

import { botGitHubSetupStep } from './BotGitHubSetupDialog'
import { GitHubInstallMount } from './GitHubInstallMount'

const bot: Bot = {
  id: 'bot-1',
  name: 'Ranger',
  hostId: 'local',
  folder: 'ranger',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

const installUrl = 'https://connector.example/github/install?state=s'
const dana = { userId: '42', login: 'dana' }
const acme = {
  installationId: '7',
  accountLogin: 'acme',
  repositories: [{ fullName: 'acme/web' }, { fullName: 'acme/api' }]
}
function state(fields: Partial<ConnectorGitHubState> = {}): ConnectorGitHubState {
  return {
    installUrl,
    account: null,
    installations: [],
    defaultBotId: null,
    ...fields
  }
}

const idle = { status: 'idle' } as const
const ready = (github: ConnectorGitHubState) => ({ status: 'ready' as const, github })
const link = (install: 'installed' | 'requested' | 'none') => ({
  // GitHub: handle is the login; no workspace and no email.
  identity: { userId: '42', name: '', handle: 'dana' },
  install
})

// A fake cloud: the trip resolves when the test says the browser came back.
let finishTrip: (result: unknown) => void = () => {}
const api = {
  botGitHub: {
    state: vi.fn(),
    connect: vi.fn(
      () =>
        new Promise((resolve) => {
          finishTrip = resolve
        })
    ),
    cancelConnect: vi.fn(async () => undefined),
    unlink: vi.fn(async () => ({ ok: true, value: undefined }))
  },
  shell: { openUrl: vi.fn() }
}

const confirm = vi.fn()

const PILL = { name: /Adding Ranger to GitHub/ }

function signIn(userId: string): void {
  useAppStore.setState({
    orcaProfileAuthStatus: {
      activeProfileId: 'p',
      configured: true,
      state: 'connected',
      persistence: 'encrypted',
      cloud: { cloudProfileId: 'c', userId, email: 'e@x.dev', linkedAt: 1 }
    }
  })
}

/** As the app mounts it: always there, showing the setup in progress, if any. */
function renderMount(): ReturnType<typeof render> {
  return render(
    <ConfirmationDialogProvider value={confirm}>
      <GitHubInstallMount />
    </ConfirmationDialogProvider>
  )
}

/** Add connector → GitHub for `subject`. */
function renderDialog(subject: Bot = bot): ReturnType<typeof render> {
  mocks.listed = [subject]
  act(() => openGitHubInstall(subject))
  return renderMount()
}

function ConfirmationDialogProvider({
  value,
  children
}: {
  value: typeof confirm
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <TooltipProvider>
      <ConfirmationDialogContext.Provider value={value}>
        {children}
      </ConfirmationDialogContext.Provider>
    </TooltipProvider>
  )
}

const overlay = (): Element | null => document.querySelector('[data-slot="dialog-overlay"]')

function stateWith(installations: (typeof acme | ConnectorGitHubState['installations'][number])[]) {
  return { ok: true, value: state({ account: dana, installations }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.updateBot.mockResolvedValue(bot)
  mocks.readBots.mockReturnValue([])
  openAppHttpLink.mockReturnValue('none')
  Object.assign(window, { api: withBotConnectorRuntime(api) })
})

afterEach(() => {
  cleanup()
  resetGitHubInstallForTests()
  stopAwaitingGitHub('local')
  cancelConnectorConnect('local', 'github')
  Reflect.deleteProperty(window, 'api')
})

describe('botGitHubSetupStep', () => {
  it('goes connect, waiting, install, turn on and done from the state and the trip', () => {
    expect(botGitHubSetupStep({ status: 'off' }, idle, false)).toEqual({
      kind: 'failed',
      code: 'github_off'
    })
    expect(botGitHubSetupStep(ready(state()), idle, false)).toEqual({
      kind: 'connect',
      error: null
    })
    expect(botGitHubSetupStep(ready(state()), { status: 'waiting' }, false)).toEqual({
      kind: 'waiting'
    })
    const signedIn = ready(state({ account: dana }))
    expect(botGitHubSetupStep(signedIn, idle, false)).toEqual({
      kind: 'install',
      login: 'dana',
      installUrl,
      requested: false
    })
    expect(
      botGitHubSetupStep(signedIn, { status: 'linked', link: link('requested') }, false)
    ).toMatchObject({ kind: 'install', requested: true })
    const installed = ready(state({ account: dana, installations: [acme] }))
    expect(botGitHubSetupStep(installed, idle, false)).toEqual({
      kind: 'turn-on',
      login: 'dana',
      installations: [acme],
      installUrl
    })
    expect(botGitHubSetupStep(installed, idle, true)).toEqual({
      kind: 'done',
      login: 'dana',
      installations: [acme],
      installUrl
    })
  })
})

describe('BotGitHubSetupDialog', () => {
  it('connects in one trip, then turns the bot on by itself and shows how to ask', async () => {
    api.botGitHub.state.mockResolvedValue({ ok: true, value: state() })
    renderDialog()

    fireEvent.click(await screen.findByRole('button', { name: /Connect GitHub/ }))
    expect(api.botGitHub.connect).toHaveBeenCalledWith({ switchAccount: false })
    expect(await screen.findByText(/Finish signing in to GitHub in your browser/)).toBeDefined()

    api.botGitHub.state.mockResolvedValue({
      ok: true,
      value: state({ account: dana, installations: [acme] })
    })
    await act(async () => finishTrip({ ok: true, value: link('installed') }))

    // No second click: the sign-in was for turning the bot on.
    await waitFor(() =>
      expect(mocks.updateBot).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }), {
        github: {}
      })
    )
    await screen.findByText('Ranger is on GitHub')
    expect(screen.getByText('2 repositories in acme')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Turn on Ranger' })).toBeNull()
    // The mention to type is set as code.
    for (const mention of screen.getAllByText('@orca-ide ranger …')) {
      expect(mention.tagName).toBe('CODE')
    }
  })

  it('leaves the bot off when the sign-in that linked was another surface’s, or another bot’s setup', async () => {
    api.botGitHub.state.mockResolvedValue({ ok: true, value: state() })
    // E.g. Settings › GitHub, earlier this session: its trip linked before this setup opened.
    const elsewhere = startConnectorConnect('local', 'github')
    api.botGitHub.state.mockResolvedValue(stateWith([acme]))
    await act(async () => {
      finishTrip({ ok: true, value: link('installed') })
      await elsewhere
    })
    renderDialog()
    expect(await screen.findByRole('button', { name: 'Turn on Ranger' })).toBeDefined()
    expect(mocks.updateBot).not.toHaveBeenCalled()
  })

  it('comes back from the pill and finishes when the sign-in links while minimized', async () => {
    api.botGitHub.state.mockResolvedValue({ ok: true, value: state() })
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: /Connect GitHub/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Minimize' }))
    expect(await screen.findByRole('status', PILL)).toBeDefined()
    expect(screen.queryByRole('dialog')).toBeNull()

    api.botGitHub.state.mockResolvedValue(stateWith([acme]))
    await act(async () => finishTrip({ ok: true, value: link('installed') }))

    expect(await screen.findByRole('dialog')).toBeDefined()
    await screen.findByText('Ranger is on GitHub')
    expect(mocks.updateBot).toHaveBeenCalledTimes(1)
  })

  it('waits for an organization owner when the install was only requested', async () => {
    api.botGitHub.state.mockResolvedValue({ ok: true, value: state() })
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: /Connect GitHub/ }))
    api.botGitHub.state.mockResolvedValue({ ok: true, value: state({ account: dana }) })
    await act(async () => finishTrip({ ok: true, value: link('requested') }))

    expect(
      await screen.findByText(
        'An owner of the organization has been asked to approve the Orca app.'
      )
    ).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /Install the Orca app/ }))
    // Per Orca's link setting, like every GitHub install button.
    expect(openAppHttpLink).toHaveBeenCalledWith(installUrl)
    expect(api.shell.openUrl).not.toHaveBeenCalledWith(installUrl)
  })

  it('shows who signed in before Done when an already-on bot reconnects', async () => {
    api.botGitHub.state.mockResolvedValue({ ok: true, value: state() })
    renderDialog({ ...bot, github: {} })
    fireEvent.click(await screen.findByRole('button', { name: /Connect GitHub/ }))
    api.botGitHub.state.mockResolvedValue({
      ok: true,
      value: state({ account: dana, installations: [acme] })
    })
    await act(async () => finishTrip({ ok: true, value: link('installed') }))
    expect(await screen.findByText('Signed in as @dana')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Turn on Ranger' })).toBeDefined()
  })

  it('"Not you?" unlinks, then starts a trip that lets the owner pick another account', async () => {
    api.botGitHub.state.mockResolvedValue({
      ok: true,
      value: state({ account: dana, installations: [acme] })
    })
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: 'Not you?' }))
    // No bot answers on GitHub, so nothing to confirm.
    expect(confirm).not.toHaveBeenCalled()
    await waitFor(() => expect(api.botGitHub.unlink).toHaveBeenCalled())
    await waitFor(() => expect(api.botGitHub.connect).toHaveBeenCalledWith({ switchAccount: true }))
  })

  it('"Add repositories or an organization" opens the install page and follows the installs', async () => {
    api.botGitHub.state.mockResolvedValue({
      ok: true,
      value: state({ account: dana, installations: [acme] })
    })
    renderDialog()
    fireEvent.click(
      await screen.findByRole('button', { name: /Add repositories or an organization/ })
    )
    expect(openAppHttpLink).toHaveBeenCalledWith(installUrl)
    expect(await screen.findByText('Checking GitHub for changes…')).toBeDefined()
    expect(api.botGitHub.unlink).not.toHaveBeenCalled()

    // Back from GitHub: the new install shows in the list.
    const globex = { installationId: '8', accountLogin: 'globex', repositories: null }
    api.botGitHub.state.mockResolvedValue({
      ok: true,
      value: state({ account: dana, installations: [acme, globex] })
    })
    expect(
      await screen.findByText('All repositories of globex', {}, { timeout: 5000 })
    ).toBeDefined()
  })

  it('minimizes to the pill by itself when GitHub opens in Orca, with no overlay left over the window', async () => {
    openAppHttpLink.mockReturnValue('orca-browser')
    api.botGitHub.state.mockResolvedValue(stateWith([acme]))
    renderDialog()
    fireEvent.click(
      await screen.findByRole('button', { name: /Add repositories or an organization/ })
    )
    expect(openAppHttpLink).toHaveBeenCalledWith(installUrl)
    expect(await screen.findByRole('status', PILL)).toBeDefined()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(overlay()).toBeNull()
    expect(document.body.style.pointerEvents).not.toBe('none')
    expect(readGitHubAwait('local')).toBe('checking')
  })

  it('stays open with Open again when GitHub opens in the system browser, and still minimizes by hand', async () => {
    openAppHttpLink.mockReturnValue('system-browser')
    api.botGitHub.state.mockResolvedValue(stateWith([acme]))
    renderDialog()
    fireEvent.click(
      await screen.findByRole('button', { name: /Add repositories or an organization/ })
    )
    expect(screen.getByRole('dialog')).toBeDefined()
    expect(screen.getByText('Finish on GitHub in your browser…')).toBeDefined()
    expect(screen.queryByRole('status', PILL)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Open again/ }))
    expect(openAppHttpLink).toHaveBeenCalledTimes(2)
    expect(openAppHttpLink).toHaveBeenLastCalledWith(installUrl)

    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    expect(await screen.findByRole('status', PILL)).toBeDefined()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(overlay()).toBeNull()
    // Minimizing keeps following GitHub.
    expect(readGitHubAwait('local')).toBe('checking')
  })

  it('Expand rebuilds the dialog from the saved setup, also after the page that opened it is gone', async () => {
    openAppHttpLink.mockReturnValue('system-browser')
    api.botGitHub.state.mockResolvedValue(stateWith([acme]))
    const first = renderDialog()
    fireEvent.click(
      await screen.findByRole('button', { name: /Add repositories or an organization/ })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    await screen.findByRole('status', PILL)
    first.unmount()

    renderMount()
    fireEvent.click(await screen.findByRole('button', { name: 'Expand' }))
    expect(await screen.findByRole('dialog')).toBeDefined()
    // Where the trip went, from the saved setup.
    expect(screen.getByText('Finish on GitHub in your browser…')).toBeDefined()
    expect(screen.queryByRole('status', PILL)).toBeNull()
    expect(readGitHubAwait('local')).toBe('checking')
  })

  it('brings a pending wait back as the pill after a restart', async () => {
    openAppHttpLink.mockReturnValue('orca-browser')
    api.botGitHub.state.mockResolvedValue(stateWith([acme]))
    const first = renderDialog()
    fireEvent.click(
      await screen.findByRole('button', { name: /Add repositories or an organization/ })
    )
    await screen.findByRole('status', PILL)
    const saved = localStorage.getItem('orca.bots.githubInstall.v1')
    first.unmount()
    // A restart: nothing in memory, only what was saved.
    resetGitHubInstallForTests()
    stopAwaitingGitHub('local')
    localStorage.setItem('orca.bots.githubInstall.v1', saved ?? '')

    renderMount()
    expect(await screen.findByRole('status', PILL)).toBeDefined()
    await waitFor(() => expect(readGitHubAwait('local')).toBe('checking'))
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(await screen.findByRole('dialog')).toBeDefined()
  })

  it('says what GitHub added, then expands on its own with the new repositories', async () => {
    openAppHttpLink.mockReturnValue('orca-browser')
    api.botGitHub.state.mockResolvedValue(stateWith([acme]))
    renderDialog()
    fireEvent.click(
      await screen.findByRole('button', { name: /Add repositories or an organization/ })
    )
    await screen.findByRole('status', PILL)
    api.botGitHub.state.mockResolvedValue(
      stateWith([{ ...acme, repositories: [...acme.repositories, { fullName: 'acme/docs' }] }])
    )
    expect(await screen.findByText('Added 1 repository', {}, { timeout: 5000 })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Review' })).toBeDefined()
    expect(readGitHubAwait('local')).toBe(null)

    expect(await screen.findByRole('dialog', {}, { timeout: 3000 })).toBeDefined()
    expect(screen.queryByRole('status', PILL)).toBeNull()
    expect(screen.getByText('Added from GitHub: acme/docs.')).toBeDefined()
  })

  it('✕ on the pill stops following GitHub and forgets the setup', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      openAppHttpLink.mockReturnValue('orca-browser')
      api.botGitHub.state.mockResolvedValue(stateWith([acme]))
      renderDialog()
      fireEvent.click(
        await screen.findByRole('button', { name: /Add repositories or an organization/ })
      )
      await screen.findByRole('status', PILL)
      fireEvent.click(screen.getByRole('button', { name: 'Stop adding Ranger to GitHub' }))
      expect(screen.queryByRole('status', PILL)).toBeNull()
      expect(readGitHubInstallRecord()).toBeNull()
      expect(localStorage.getItem('orca.bots.githubInstall.v1')).toBeNull()
      expect(readGitHubAwait('local')).toBe(null)
      const reads = api.botGitHub.state.mock.calls.length
      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        await vi.advanceTimersByTimeAsync(5 * 60_000)
      })
      expect(api.botGitHub.state.mock.calls.length).toBe(reads)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads one at a time: every 3 s, then every 30 s, at once and every 1 s for a while on focus, never two at once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      openAppHttpLink.mockReturnValue('orca-browser')
      api.botGitHub.state.mockResolvedValue(stateWith([acme]))
      renderDialog()
      fireEvent.click(
        await screen.findByRole('button', { name: /Add repositories or an organization/ })
      )
      await screen.findByRole('status', PILL)
      const reads = (): number => api.botGitHub.state.mock.calls.length
      await act(async () => vi.advanceTimersByTimeAsync(1))
      let before = reads()
      await act(async () => vi.advanceTimersByTimeAsync(3_000))
      expect(reads()).toBe(before + 1)

      // Expanding and minimizing again keeps the same wait instead of starting another.
      fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Minimize' }))
      before = reads()
      await act(async () => vi.advanceTimersByTimeAsync(3_000))
      expect(reads()).toBe(before + 1)

      // Past the first 2 minutes the reads are 30 s apart.
      await act(async () => vi.advanceTimersByTimeAsync(3 * 60_000))
      before = reads()
      while (reads() === before) {
        await act(async () => vi.advanceTimersByTimeAsync(1_000))
      }
      before = reads()
      await act(async () => vi.advanceTimersByTimeAsync(29_000))
      expect(reads()).toBe(before)
      await act(async () => vi.advanceTimersByTimeAsync(1_000))
      expect(reads()).toBe(before + 1)

      // Back in Orca's window, or in a chat: a read now, not at the next tick.
      before = reads()
      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(reads()).toBe(before + 1)
      // And every 1 s for a while after: GitHub may still be saving.
      before = reads()
      await act(async () => vi.advanceTimersByTimeAsync(1_000))
      expect(reads()).toBe(before + 1)
      const chat = document.createElement('div')
      chat.setAttribute('data-native-chat-root', 'true')
      const input = document.createElement('textarea')
      chat.append(input)
      document.body.append(chat)
      before = reads()
      await act(async () => {
        input.focus()
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(reads()).toBe(before + 1)
      chat.remove()

      // A read still out when focus comes back is not doubled.
      let answer: (value: unknown) => void = () => {}
      api.botGitHub.state.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = resolve
          })
      )
      await act(async () => vi.advanceTimersByTimeAsync(30_000))
      before = reads()
      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        window.dispatchEvent(new Event('focus'))
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(reads()).toBe(before)
      await act(async () => answer(stateWith([acme])))
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps waiting through a failed read, and still sees GitHub save once reads recover', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      openAppHttpLink.mockReturnValue('orca-browser')
      api.botGitHub.state.mockResolvedValue(stateWith([acme]))
      renderDialog()
      fireEvent.click(
        await screen.findByRole('button', { name: /Add repositories or an organization/ })
      )
      await screen.findByRole('status', PILL)
      // Offline after waking from sleep: the read fails and the shared wait stops.
      api.botGitHub.state.mockResolvedValue({ ok: false, error: 'connector_failed' })
      await act(async () => vi.advanceTimersByTimeAsync(3_000))
      expect(readGitHubAwait('local')).toBe(null)
      expect(readGitHubInstallRecord()?.waiting).toBe(true)
      expect(localStorage.getItem('orca.bots.githubInstall.v1')).not.toBeNull()
      expect(screen.getByRole('status', PILL)).toBeDefined()

      // Back online, and the owner saved on GitHub meanwhile.
      api.botGitHub.state.mockResolvedValue(
        stateWith([{ ...acme, repositories: [...acme.repositories, { fullName: 'acme/docs' }] }])
      )
      await act(async () => vi.advanceTimersByTimeAsync(30_000))
      expect(await screen.findByText('Added 1 repository')).toBeDefined()
      expect(readGitHubInstallRecord()?.waiting).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps waiting when the Orca account signs in after a restart', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      openAppHttpLink.mockReturnValue('orca-browser')
      api.botGitHub.state.mockResolvedValue(stateWith([acme]))
      const first = renderDialog()
      fireEvent.click(
        await screen.findByRole('button', { name: /Add repositories or an organization/ })
      )
      await screen.findByRole('status', PILL)
      const saved = localStorage.getItem('orca.bots.githubInstall.v1')
      first.unmount()
      resetGitHubInstallForTests()
      stopAwaitingGitHub('local')
      localStorage.setItem('orca.bots.githubInstall.v1', saved ?? '')

      renderMount()
      await screen.findByRole('status', PILL)
      await waitFor(() => expect(readGitHubAwait('local')).toBe('checking'))
      // The account hydrates: the GitHub state resets and its wait stops.
      act(() => signIn('user-after-restart'))
      expect(readGitHubInstallRecord()?.waiting).toBe(true)
      await act(async () => vi.advanceTimersByTimeAsync(3_100))
      expect(readGitHubAwait('local')).toBe('checking')
      expect(screen.getByRole('status', PILL)).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends the setup when its bot is deleted', async () => {
    openAppHttpLink.mockReturnValue('orca-browser')
    api.botGitHub.state.mockResolvedValue(stateWith([acme]))
    renderDialog()
    fireEvent.click(
      await screen.findByRole('button', { name: /Add repositories or an organization/ })
    )
    await screen.findByRole('status', PILL)
    mocks.listed = []
    act(() => publishBots([], { threadReplies: false, webhooks: undefined }))
    await waitFor(() => expect(screen.queryByRole('status', PILL)).toBeNull())
    expect(readGitHubInstallRecord()).toBeNull()
    expect(readGitHubAwait('local')).toBe(null)
  })

  it('Close ends the wait and its focus listener', async () => {
    openAppHttpLink.mockReturnValue('system-browser')
    api.botGitHub.state.mockResolvedValue(stateWith([acme]))
    renderDialog()
    fireEvent.click(
      await screen.findByRole('button', { name: /Add repositories or an organization/ })
    )
    expect(readGitHubAwait('local')).toBe('checking')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('status', PILL)).toBeNull()
    expect(readGitHubAwait('local')).toBe(null)
    const reads = api.botGitHub.state.mock.calls.length
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await act(async () => {})
    expect(api.botGitHub.state.mock.calls.length).toBe(reads)
  })

  it("setup for another bot ends the first one's wait", async () => {
    openAppHttpLink.mockReturnValue('orca-browser')
    api.botGitHub.state.mockResolvedValue(stateWith([acme]))
    renderDialog()
    fireEvent.click(
      await screen.findByRole('button', { name: /Add repositories or an organization/ })
    )
    await screen.findByRole('status', PILL)
    const scout = { ...bot, id: 'bot-2', name: 'Scout' }
    mocks.listed = [bot, scout]
    act(() => openGitHubInstall(scout))
    expect(readGitHubAwait('local')).toBe(null)
    expect(await screen.findByRole('dialog')).toBeDefined()
    expect(screen.queryByRole('status', PILL)).toBeNull()
  })

  it('leaves a wait another surface started when it closes', async () => {
    api.botGitHub.state.mockResolvedValue(stateWith([acme]))
    renderDialog()
    await screen.findByRole('button', { name: /Add repositories or an organization/ })
    // E.g. the repo card's Add repositories or organizations.
    act(() => {
      awaitGitHubChange('local')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop adding Ranger to GitHub' }))
    expect(readGitHubAwait('local')).toBe('checking')
  })

  it('"Not you?" asks first when a bot answers on GitHub, and keeps the link on Cancel', async () => {
    mocks.readBots.mockReturnValue([
      { ...bot, name: 'Scout', github: {} },
      { ...bot, id: 'paused', name: 'Sleepy', github: {}, paused: true },
      { ...bot, id: 'unlinked', name: 'Elsewhere', github: null }
    ])
    confirm.mockResolvedValue(false)
    api.botGitHub.state.mockResolvedValue({
      ok: true,
      value: state({ account: dana, installations: [acme] })
    })
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: 'Not you?' }))
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Sign out of GitHub as @dana?',
          description: 'Scout answers on GitHub now. It stops until you sign in as @dana again.'
        })
      )
    )
    // Let a wrongly ignored Cancel reach the unlink before asserting it did not.
    await act(async () => {})
    expect(api.botGitHub.unlink).not.toHaveBeenCalled()
    expect(api.botGitHub.connect).not.toHaveBeenCalled()
  })
})
