// @vitest-environment happy-dom

import { withBotConnectorRuntime } from '../../../lib/bot-connector-host-calls.test-fixture'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  cancelConnectorConnect,
  redeemConnectorLink,
  startConnectorConnect
} from '@/lib/connector-connect-state'
import type { Bot } from '../../../../../shared/bot-types'
import type {
  ConnectorLinearState,
  ConnectorLinearWorkspace
} from '../../../../../shared/connector-bot-linear-contract'

const mocks = vi.hoisted(() => ({ updateBot: vi.fn(), readBots: vi.fn((): Bot[] => []) }))
vi.mock('@/lib/bot-catalog', () => ({
  updateBot: mocks.updateBot,
  readHostBots: () => mocks.readBots()
}))

import type * as BotHostPage from '@/lib/bot-host-page'

// Where the sign-in page opens; a paired server's opens in Orca's browser.
const openBotHostPage = vi.hoisted(() => vi.fn())
vi.mock('@/lib/bot-host-page', async (actual) => {
  const real = await actual<typeof BotHostPage>()
  openBotHostPage.mockImplementation(real.openBotHostPage)
  return { ...real, openBotHostPage }
})

import { CONNECT_HELP_AFTER_MS } from '../connector-connect-parts'
import { BotLinearSetupDialog } from './BotLinearSetupDialog'
import { botLinearSetupStep } from './linear-setup-step'

const bot: Bot = {
  id: 'bot-1',
  name: 'Reviewer',
  hostId: 'local',
  folder: 'reviewer',
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

function workspace(fields: Partial<ConnectorLinearWorkspace> = {}): ConnectorLinearWorkspace {
  return {
    workspaceId: 'org-1',
    name: 'Acme',
    urlKey: 'acme',
    installed: true,
    userId: 'L-me',
    userName: 'Dana',
    defaultBotId: null,
    ...fields
  }
}

const slackSam = { id: 'U-sam', name: 'Sam' }
const acmeBea = { id: 'L-bea', name: 'Bea', source: 'linear', workspaceId: 'org-1' }

const installUrl = 'https://connector.example/linear/install?state=s'
const state = (workspaces: ConnectorLinearWorkspace[]): ConnectorLinearState => ({
  installUrl,
  workspaces
})
const choice = { workspaceId: null, done: false }
const idle = { status: 'idle' } as const
const ready = (linear: ConnectorLinearState) => ({ status: 'ready' as const, linear })
const link = (fields: { install?: 'installed' | 'needs_admin'; workspaceId?: string } = {}) => ({
  identity: { userId: 'L-me', name: 'Dana', handle: 'dana', email: 'dana@acme.dev' },
  workspace: { id: fields.workspaceId ?? 'org-1', name: 'Acme', urlKey: 'acme' },
  install: fields.install ?? 'installed'
})

// A fake cloud: the trip resolves when the test says the browser came back.
let finishTrip: (result: unknown) => void = () => {}
const api = {
  botLinear: {
    state: vi.fn(),
    connect: vi.fn(
      () =>
        new Promise((resolve) => {
          finishTrip = resolve
        })
    ),
    cancelConnect: vi.fn(async () => undefined),
    redeem: vi.fn(),
    unlink: vi.fn(async () => ({ ok: true, value: undefined }))
  },
  shell: { openUrl: vi.fn() },
  ui: { writeClipboardText: vi.fn(async () => undefined) }
}

const confirm = vi.fn()

function renderDialog(subject: Bot = bot): void {
  render(
    <TooltipProvider>
      <ConfirmationDialogContext.Provider value={confirm}>
        <BotLinearSetupDialog bot={subject} open onOpenChange={() => {}} />
      </ConfirmationDialogContext.Provider>
    </TooltipProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.updateBot.mockResolvedValue(bot)
  mocks.readBots.mockReturnValue([])
  Object.assign(window, { api: withBotConnectorRuntime(api) })
})

afterEach(() => {
  cleanup()
  cancelConnectorConnect('local', 'linear')
  Reflect.deleteProperty(window, 'api')
})

describe('botLinearSetupStep', () => {
  it('goes connect, waiting, then needs-admin or turn on, from the state and the trip', () => {
    expect(botLinearSetupStep({ status: 'off' }, idle, choice)).toEqual({
      kind: 'failed',
      code: 'linear_off'
    })
    expect(botLinearSetupStep(ready(state([])), idle, choice)).toEqual({
      kind: 'connect',
      error: null
    })
    expect(
      botLinearSetupStep(ready(state([])), { status: 'failed', error: 'expired' }, choice)
    ).toEqual({ kind: 'connect', error: 'expired' })
    expect(botLinearSetupStep(ready(state([])), { status: 'waiting' }, choice)).toEqual({
      kind: 'waiting'
    })
    // Linked in two workspaces: the trip's own workspace wins, else the owner picks one.
    const two = [workspace(), workspace({ workspaceId: 'org-2', name: 'Beta', installed: false })]
    expect(botLinearSetupStep(ready(state(two)), idle, choice)).toEqual({
      kind: 'pick',
      workspaces: two
    })
    // A failed trip keeps the picker; the dialog says why above it.
    expect(
      botLinearSetupStep(ready(state(two)), { status: 'failed', error: 'expired' }, choice)
    ).toEqual({ kind: 'pick', workspaces: two })
    // The picker leaves out workspaces the bot is already in.
    const three = [...two, workspace({ workspaceId: 'org-3', name: 'Gamma' })]
    expect(botLinearSetupStep(ready(state(three)), idle, { ...choice, taken: ['org-1'] })).toEqual({
      kind: 'pick',
      workspaces: [two[1], three[2]]
    })
    expect(
      botLinearSetupStep(
        ready(state(two)),
        { status: 'linked', link: link({ workspaceId: 'org-2', install: 'needs_admin' }) },
        choice
      )
    ).toEqual({ kind: 'needs-admin', workspace: two[1], installUrl })
    expect(
      botLinearSetupStep(ready(state(two)), idle, { ...choice, workspaceId: 'org-1' })
    ).toEqual({ kind: 'turn-on', workspace: two[0] })
    // Adding another workspace never picks one the bot is already in, even when it is the only one linked.
    expect(
      botLinearSetupStep(ready(state([workspace()])), idle, { ...choice, taken: ['org-1'] }).kind
    ).toBe('connect')
    expect(botLinearSetupStep(ready(state(two)), idle, { ...choice, taken: ['org-1'] })).toEqual({
      kind: 'needs-admin',
      workspace: two[1],
      installUrl
    })
  })
})

describe('BotLinearSetupDialog', () => {
  it('connects in one trip, then turns the bot on by itself and shows how to ask', async () => {
    api.botLinear.state.mockResolvedValue({ ok: true, value: state([]) })
    const members = [
      slackSam,
      acmeBea,
      { id: 'L-cy', name: 'Cy', source: 'linear', workspaceId: 'org-2' }
    ]
    renderDialog({ ...bot, members })

    fireEvent.click(await screen.findByRole('button', { name: /Connect Linear/ }))
    expect(api.botLinear.connect).toHaveBeenCalledWith({ switchAccount: false })
    expect(await screen.findByText(/Finish signing in to Linear in your browser/)).toBeDefined()

    // The browser came back: the cloud now reports the link.
    api.botLinear.state.mockResolvedValue({ ok: true, value: state([workspace()]) })
    await act(async () => finishTrip({ ok: true, value: link() }))

    // No second click: the sign-in was for turning the bot on.
    await waitFor(() =>
      expect(mocks.updateBot).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }), {
        // The linear.app address is kept, so a same-named workspace is never mistaken for it.
        linearWorkspaces: [{ workspaceId: 'org-1', workspaceName: 'Acme', urlKey: 'acme' }]
      })
    )
    expect(await screen.findByText('Reviewer is on Linear')).toBeDefined()
    // The done screen names the workspace it was turned on in, and how to ask there.
    expect(screen.getByText('Signed in as Dana in Acme (linear.app/acme)')).toBeDefined()
    expect(screen.getByText('bot:reviewer')).toBeDefined()
  })

  it('leaves the bot off when the sign-in that linked was another surface’s', async () => {
    api.botLinear.state.mockResolvedValue({ ok: true, value: state([]) })
    // E.g. Settings › Linear: its trip links before this setup opens.
    const elsewhere = startConnectorConnect('local', 'linear')
    api.botLinear.state.mockResolvedValue({ ok: true, value: state([workspace()]) })
    await act(async () => {
      finishTrip({ ok: true, value: link() })
      await elsewhere
    })
    renderDialog()
    expect(await screen.findByRole('button', { name: 'Turn on Reviewer' })).toBeDefined()
    expect(mocks.updateBot).not.toHaveBeenCalled()
  })

  it('steps aside to a pill while Linear is open in Orca’s browser, and comes back turned on', async () => {
    openBotHostPage.mockReturnValueOnce('orca-browser')
    api.botLinear.state.mockResolvedValue({ ok: true, value: state([]) })
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: /Connect Linear/ }))
    expect(await screen.findByRole('status', { name: /Adding Reviewer to Linear/ })).toBeDefined()
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull()

    api.botLinear.state.mockResolvedValue({ ok: true, value: state([workspace()]) })
    await act(async () => finishTrip({ ok: true, value: link() }))
    expect(await screen.findByText('Reviewer is on Linear')).toBeDefined()
    expect(screen.queryByRole('status', { name: /Adding Reviewer to Linear/ })).toBeNull()
  })

  it('shows the trip’s error and lets the owner connect again', async () => {
    api.botLinear.state.mockResolvedValue({ ok: true, value: state([]) })
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: /Connect Linear/ }))
    await act(async () => finishTrip({ ok: false, error: 'expired' }))
    expect(
      await screen.findByText(
        'Linear didn’t finish. A newer Linear or GitHub connect may have replaced it. Start again.'
      )
    ).toBeDefined()
    expect(screen.getByRole('button', { name: /Connect Linear/ })).toBeDefined()
  })

  it('stops waiting on Cancel', async () => {
    api.botLinear.state.mockResolvedValue({ ok: true, value: state([]) })
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: /Connect Linear/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(api.botLinear.cancelConnect).toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: /Connect Linear/ })).toBeDefined()
  })

  it('says what a trip that never returns likely hit, once it has waited past a normal sign-in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      api.botLinear.state.mockResolvedValue({ ok: true, value: state([]) })
      renderDialog()
      fireEvent.click(await screen.findByRole('button', { name: /Connect Linear/ }))
      expect(await screen.findByText(/Finish signing in to Linear in your browser/)).toBeDefined()
      expect(screen.queryByText(/Could not find OAuth client/)).toBeNull()
      act(() => vi.advanceTimersByTime(CONNECT_HELP_AFTER_MS))
      expect(
        screen.getByText(
          'Stuck on a Linear page that says “Could not find OAuth client”? Orca’s Linear app isn’t open to this workspace yet. An admin of the workspace that owns the app must make it public.'
        )
      ).toBeDefined()
    } finally {
      vi.useRealTimers()
      cancelConnectorConnect('local', 'linear')
    }
  })

  it('redeems an "Open Orca" return in place when no loopback could open', async () => {
    api.botLinear.state.mockResolvedValue({ ok: true, value: state([]) })
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: /Connect Linear/ }))
    await act(async () => finishTrip({ ok: true, value: null }))
    // Still waiting: the trip ends at "Open Orca", whose deep link carries the result.
    expect(screen.getByText(/Finish signing in to Linear in your browser/)).toBeDefined()

    api.botLinear.state.mockResolvedValue({ ok: true, value: state([workspace()]) })
    api.botLinear.redeem.mockResolvedValue({ ok: true, value: link() })
    await act(async () => {
      await redeemConnectorLink('linear', 'r'.repeat(43))
    })
    expect(api.botLinear.redeem).toHaveBeenCalledWith({ result: 'r'.repeat(43) })
    expect(await screen.findByText('Reviewer is on Linear')).toBeDefined()
  })

  it('"Use another workspace" starts a trip without unlinking, and keeps the linked workspace', async () => {
    api.botLinear.state.mockResolvedValue({ ok: true, value: state([workspace()]) })
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: /Use another workspace/ }))
    expect(api.botLinear.connect).toHaveBeenCalledWith({ switchAccount: true })
    expect(api.botLinear.unlink).not.toHaveBeenCalled()

    const beta = workspace({ workspaceId: 'org-2', name: 'Beta', urlKey: 'beta' })
    api.botLinear.state.mockResolvedValue({ ok: true, value: state([workspace(), beta]) })
    await act(async () => finishTrip({ ok: true, value: link({ workspaceId: 'org-2' }) }))
    // It goes on into the workspace just picked.
    expect(await screen.findByText('Signed in as Dana in Beta (linear.app/beta)')).toBeDefined()
    expect(api.botLinear.unlink).not.toHaveBeenCalled()
  })

  it('a failed "Use another workspace" trip keeps the linked workspace and says why', async () => {
    api.botLinear.state.mockResolvedValue({ ok: true, value: state([workspace()]) })
    renderDialog()
    await screen.findByText('Signed in as Dana in Acme (linear.app/acme)')
    fireEvent.click(screen.getByRole('button', { name: /Use another workspace/ }))
    await act(async () => finishTrip({ ok: false, error: 'expired' }))
    expect(
      await screen.findByText(
        'Linear didn’t finish. A newer Linear or GitHub connect may have replaced it. Start again.'
      )
    ).toBeDefined()
    expect(screen.getByText('Signed in as Dana in Acme (linear.app/acme)')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Turn on Reviewer' })).toBeDefined()
  })

  it('picks among several linked workspaces, then shows the one picked', async () => {
    const beta = workspace({ workspaceId: 'org-2', name: 'Beta', urlKey: 'beta' })
    api.botLinear.state.mockResolvedValue({ ok: true, value: state([workspace(), beta]) })
    renderDialog()
    expect(await screen.findByText('Choose a Linear workspace.')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Beta (linear.app/beta)' }))
    expect(await screen.findByText(/Signed in as Dana in Beta \(linear.app\/beta\)/)).toBeDefined()
  })

  it('"Not you?" asks first when bots answer in that workspace, and keeps it on Cancel', async () => {
    const inAcme = (name: string, fields: Partial<Bot> = {}): Bot => ({
      ...bot,
      id: name,
      name,
      linearWorkspaces: [{ workspaceId: 'org-1', workspaceName: 'Acme', urlKey: 'acme' }],
      ...fields
    })
    mocks.readBots.mockReturnValue([
      inAcme('Scout'),
      inAcme('Triage', {
        linearWorkspaces: undefined,
        linear: { workspaceId: 'org-1', workspaceName: 'Acme', urlKey: 'acme' }
      }),
      inAcme('Sleepy', { paused: true }),
      inAcme('Elsewhere', {
        linearWorkspaces: [{ workspaceId: 'org-2', workspaceName: 'Beta', urlKey: 'beta' }]
      })
    ])
    confirm.mockResolvedValue(false)
    api.botLinear.state.mockResolvedValue({ ok: true, value: state([workspace()]) })
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: 'Not you?' }))
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Sign out of Acme?',
          description:
            'Scout and Triage answer there now. They stop until you sign in to this workspace again.',
          confirmLabel: 'Sign out',
          confirmVariant: 'destructive'
        })
      )
    )
    // Let a wrongly ignored Cancel reach the unlink before asserting it did not.
    await act(async () => {})
    expect(api.botLinear.unlink).not.toHaveBeenCalled()
    expect(api.botLinear.connect).not.toHaveBeenCalled()

    confirm.mockResolvedValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Not you?' }))
    await waitFor(() => expect(api.botLinear.unlink).toHaveBeenCalledWith({ workspaceId: 'org-1' }))
  })

  it('"Not you?" unlinks, then starts a trip that lets the owner pick another account', async () => {
    api.botLinear.state.mockResolvedValue({ ok: true, value: state([workspace()]) })
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: 'Not you?' }))
    // No bot answers there, so nothing to confirm.
    expect(confirm).not.toHaveBeenCalled()
    api.botLinear.state.mockResolvedValue({ ok: true, value: state([]) })
    await waitFor(() => expect(api.botLinear.unlink).toHaveBeenCalledWith({ workspaceId: 'org-1' }))
    await waitFor(() => expect(api.botLinear.connect).toHaveBeenCalledWith({ switchAccount: true }))

    // Cancelling the new trip never brings back the account just unlinked.
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('button', { name: /Connect Linear/ })).toBeDefined()
    expect(screen.queryByText(/Signed in as Dana/)).toBeNull()
  })

  it('keeps Copy link for an admin whole, whatever the workspace is called', async () => {
    const long = workspace({
      installed: false,
      name: 'A workspace with a very long name that once pushed the buttons off the dialog',
      urlKey: 'a-very-long-workspace-address'
    })
    api.botLinear.state.mockResolvedValue({ ok: true, value: state([long]) })
    renderDialog()

    const copy = await screen.findByRole('button', { name: 'Copy link for an admin' })
    // The workspace is named in the text, never inside a button.
    expect(
      screen.getByText(/Orca is not installed in A workspace with a very long name/)
    ).toBeDefined()
    expect(screen.queryByRole('button', { name: /very long name/ })).toBeNull()
    fireEvent.click(copy)
    await waitFor(() => expect(api.ui.writeClipboardText).toHaveBeenCalledWith(installUrl))
  })
})
