// @vitest-environment happy-dom

import { withBotConnectorRuntime } from '../../../lib/bot-connector-host-calls.test-fixture'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  applyBotMemberUpdates,
  type BotUpdateParams
} from '../../../../../shared/rpc-contract/bots-params'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot, BotMember } from '../../../../../shared/bot-types'
import type { ConnectorAccessRequest } from '../../../../../shared/connector-bot-access-contract'

const mocks = vi.hoisted(() => {
  const members: BotMember[] = []
  const bots: { id: string; hostId?: string; name: string }[] = []
  return {
    updateBot: vi.fn(),
    refreshBotHost: vi.fn(),
    decide: vi.fn(),
    list: vi.fn(),
    members,
    bots
  }
})
// The window reads and answers through the host's bots.access routes, as a paired phone does.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (_target: unknown, method: string, params: unknown) =>
    method === 'bots.access.decide'
      ? mocks.decide(params)
      : method === 'bots.access.list'
        ? mocks.list()
        : method.startsWith('bots.slack.')
          ? window.api.runtime
              .call({ method, params })
              .then((response: unknown) =>
                typeof response === 'object' && response !== null && 'result' in response
                  ? response.result
                  : undefined
              )
          : Promise.reject(new Error(`unexpected ${method}`))
}))
// Edits apply to the list the test's bot holds.
vi.mock('@/lib/bot-catalog', () => ({
  // The confirm's own facts aren't under test here; unlisted, it shows its most cautious ones.
  useHostBots: () => [],
  // The host applies only the people an update adds or takes off; the list it leaves is what the test checks.
  updateBot: (botId: string, updates: BotUpdateParams['updates']) =>
    updates.permissionMode !== undefined
      ? mocks.updateBot(botId, updates)
      : mocks.updateBot(botId, {
          members: updates.members ?? applyBotMemberUpdates(mocks.members, updates)
        }),
  openBotHome: () => false,
  readBots: () => mocks.bots,
  readBotsEnabled: () => true,
  refreshBotHost: mocks.refreshBotHost
}))

vi.mock('@/store', () => {
  const state = {
    setContextualToursBlockingSurfaceVisible: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn()
  }
  return {
    useAppStore: Object.assign(
      (selector: (value: Record<string, unknown>) => unknown) => selector(state),
      { getState: () => state, subscribe: () => () => {} }
    )
  }
})

import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import { BotSlackCard } from './BotSlackCard'
import { refreshAccessRequests, reviewAccessRequest } from '@/lib/bot-access-requests'
import { BotWhoCanAskList } from '../BotWhoCanAskList'
import { useSlackWhoCanAsk } from './use-slack-who-can-ask'

function BotWhoCanAsk({ bot }: { bot: Bot }): React.JSX.Element {
  return <BotWhoCanAskList bot={bot} service={useSlackWhoCanAsk(bot)} />
}

function bot(id = 'bot-1'): Bot {
  return {
    id,
    name: 'Reviewer',
    hostId: 'local',
    folder: 'reviewer',
    folderWorkspaceId: 'fw-1',
    agent: 'claude',
    avatar: null,
    paused: false,
    permissionMode: 'ask',
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [{ id: 'U-sam', name: 'Sam Lee' }],
    slack: { appId: 'A1', teamId: 'T1' },
    chatSessionId: null,
    linear: null,
    github: null,
    createdAt: 1,
    updatedAt: 1
  }
}

// Answered requests stay answered for the run, so each test asks anew.
let nextRequest = 0
let requestId = ''
const request = (fields: Partial<ConnectorAccessRequest> = {}): ConnectorAccessRequest => ({
  requestId,
  botId: 'bot-1',
  source: 'slack',
  workspaceId: 'T1',
  workspaceName: 'Globex',
  requester: {
    id: 'U-pat',
    name: 'Pat',
    handle: 'pat',
    detail: 'Pat Doe',
    avatarUrl: 'https://avatars.slack-edge.com/pat_72.png'
  },
  createdAt: 1,
  expiresAt: 2,
  ...fields
})

const slack = {
  state: vi.fn(),
  members: vi.fn()
}
const access = { list: mocks.list, decide: mocks.decide }

async function showRequests(requests: ConnectorAccessRequest[], botId = 'bot-1'): Promise<void> {
  access.list.mockResolvedValue({ ok: true, value: requests })
  await act(() => refreshAccessRequests())
  render(
    <ConfirmationDialogProvider>
      <BotWhoCanAsk bot={bot(botId)} />
    </ConfirmationDialogProvider>
  )
}

beforeEach(() => {
  requestId = `req-${++nextRequest}`
  mocks.updateBot.mockReset().mockResolvedValue(bot())
  mocks.members = bot().members
  mocks.bots = [{ id: 'bot-1', hostId: 'local', name: 'Reviewer' }]
  slack.state.mockReset().mockResolvedValue({
    ok: true,
    value: {
      state: 'installed',
      teamId: 'T1',
      teamName: 'Globex',
      appId: 'A1',
      botUserId: 'UB',
      installerUserId: 'UI'
    }
  })
  slack.members.mockReset().mockResolvedValue({ ok: true, value: { members: [], complete: true } })
  access.decide.mockReset().mockResolvedValue({ ok: true, value: undefined })
  mocks.refreshBotHost.mockReset().mockResolvedValue(undefined)
  Object.assign(window, { api: withBotConnectorRuntime({ botSlack: slack }) })
})

afterEach(async () => {
  cleanup()
  // Empty the shared list for the next test.
  access.list.mockResolvedValue({ ok: true, value: [] })
  await refreshAccessRequests()
  Reflect.deleteProperty(window, 'api')
})

describe('Request access in Who can ask', () => {
  it('lists who asked, as Slack vouched for them, only for the workspace the bot is in', async () => {
    await showRequests([
      request(),
      request({ requestId: `${requestId}-b`, workspaceId: 'T2' }),
      request({ requestId: `${requestId}-c`, botId: 'bot-2' })
    ])
    const rows = await screen.findAllByRole('button', { name: 'Review…' })
    expect(rows).toHaveLength(1)
    expect(screen.getByText(/^@pat · Pat Doe · /)).toBeInTheDocument()
  })

  it('lists who asked in their own section, never among the people with access', async () => {
    await showRequests([request()])
    expect(await screen.findByText(/^Asking for access/)).toHaveTextContent('Asking for access1')
    expect(screen.getByText(/^Who can ask Reviewer/)).toHaveTextContent(/^Who can ask Reviewer$/)
    expect(screen.queryByRole('button', { name: 'Remove Pat' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove Sam Lee' })).toBeInTheDocument()
  })

  it('shows no request section when nobody is asking', async () => {
    await showRequests([])
    expect(await screen.findByText(/^Who can ask Reviewer/)).toBeInTheDocument()
    expect(screen.queryByText(/^Asking for access/)).toBeNull()
  })

  it('says on the closed row how many are asking', async () => {
    await showRequests([request(), request({ requestId: `${requestId}-b` })])
    cleanup()
    render(
      <ConfirmationDialogProvider>
        <BotSlackCard bot={bot('bot-1')} />
      </ConfirmationDialogProvider>
    )
    expect(await screen.findByText('2 requests')).toBeInTheDocument()
  })

  it('asks before giving access; Escape just closes, adding nobody', async () => {
    await showRequests([request()])
    fireEvent.click(await screen.findByRole('button', { name: 'Review…' }))
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // Still waiting: closing isn't an answer, since declining starts the requester's cooldown.
    expect(access.decide).not.toHaveBeenCalled()
    expect(mocks.updateBot).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Review…' })).toBeInTheDocument()
  })

  it('declines on the confirm’s Reject, which answers the request, and adds nobody', async () => {
    await showRequests([request()])
    fireEvent.click(await screen.findByRole('button', { name: 'Review…' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(access.decide).toHaveBeenCalledTimes(1)
    expect(access.decide).toHaveBeenCalledWith({ requestId, decision: 'declined' })
    expect(mocks.updateBot).not.toHaveBeenCalled()
  })

  it('answers nothing on the held Enter or double-click that opened it; a press outside leaves it waiting', async () => {
    await showRequests([request()])
    fireEvent.click(await screen.findByRole('button', { name: 'Review…' }))
    const dialog = await screen.findByRole('dialog')
    const reject = within(dialog).getByRole('button', { name: 'Reject' })
    await waitFor(() => expect(reject).toHaveFocus())
    expect(fireEvent.keyDown(reject, { key: 'Enter', repeat: true })).toBe(false)
    fireEvent.click(reject, { detail: 2 })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Give access' }), { detail: 2 })
    expect(access.decide).not.toHaveBeenCalled()

    // A press outside: Radix answers it on the click that follows.
    fireEvent.pointerDown(document.body)
    fireEvent.click(document.body)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(access.decide).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Review…' })).toBeInTheDocument()
  })

  it('keeps a held Enter from rejecting the next request once one is rejected', async () => {
    await showRequests([request()])
    fireEvent.click(await screen.findByRole('button', { name: 'Review…' }))
    await screen.findByText('Give Pat access to Reviewer?')
    const lee = { ...request().requester, id: 'U-lee', name: 'Lee', handle: 'lee', detail: 'Lee' }
    const next = request({ requestId: `${requestId}-b`, requester: lee })
    act(() => reviewAccessRequest({ ...next, hostId: 'local' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reject' }))

    await screen.findByText('Give Lee access to Reviewer?')
    const reject = within(screen.getByRole('dialog')).getByRole('button', { name: 'Reject' })
    await waitFor(() => expect(reject).toHaveFocus())
    expect(fireEvent.keyDown(reject, { key: 'Enter', repeat: true })).toBe(false)
    expect(access.decide).toHaveBeenCalledTimes(1)
    expect(access.decide).toHaveBeenCalledWith({ requestId, decision: 'declined' })
  })

  it('grants on the host on Give access, which adds the person, then rereads the bot', async () => {
    await showRequests([request()])
    fireEvent.click(await screen.findByRole('button', { name: 'Review…' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Give access' }))
    await waitFor(() =>
      expect(access.decide).toHaveBeenCalledWith({ requestId, decision: 'granted' })
    )
    await waitFor(() => expect(mocks.refreshBotHost).toHaveBeenCalled())
    // The host adds the person once the cloud records the grant; the window adds no one itself.
    expect(mocks.updateBot).not.toHaveBeenCalled()
  })

  it('declines without asking, and adds nobody', async () => {
    await showRequests([request()])
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }))
    expect(access.decide).toHaveBeenCalledWith({ requestId, decision: 'declined' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.updateBot).not.toHaveBeenCalled()
  })

  it('opens the owner’s link straight onto the confirmation', async () => {
    await showRequests([])
    act(() => reviewAccessRequest({ ...request(), hostId: 'local' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Give Pat access to Reviewer?')).toBeInTheDocument()
    // Reject focused: Enter can't grant access by accident.
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Reject' })).toHaveFocus()
    )
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(access.decide).not.toHaveBeenCalled()
    expect(mocks.updateBot).not.toHaveBeenCalled()
  })

  it('leaves a linked request for another workspace alone', async () => {
    await showRequests([])
    act(() => reviewAccessRequest({ ...request({ workspaceId: 'T2' }), hostId: 'local' }))
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(access.decide).not.toHaveBeenCalled()
  })

  it('waits for Slack’s workspace before opening the owner’s link', async () => {
    let installed: (value: unknown) => void = () => {}
    slack.state.mockReturnValue(new Promise((resolve) => (installed = resolve)))
    await showRequests([], 'bot-late')
    act(() => reviewAccessRequest({ ...request({ botId: 'bot-late' }), hostId: 'local' }))
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () =>
      installed({
        ok: true,
        value: {
          state: 'installed',
          teamId: 'T1',
          teamName: 'Globex',
          appId: 'A1',
          botUserId: 'UB',
          installerUserId: 'UI'
        }
      })
    )
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('keeps a request whose answer could not be saved, and never revives an answered one', async () => {
    await showRequests([request()])
    access.decide.mockResolvedValueOnce({ ok: false, error: 'cloud_unreachable' })
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }))
    expect(await screen.findByRole('button', { name: 'Decline' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull())
    // A read that started before the answer still lists it.
    access.list.mockResolvedValue({ ok: true, value: [request()] })
    await act(() => refreshAccessRequests())
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull()
  })

  it('drops every request once Orca is signed out', async () => {
    await showRequests([request()])
    expect(await screen.findByRole('button', { name: 'Decline' })).toBeInTheDocument()
    access.list.mockResolvedValue({ ok: false, error: 'signed_out' })
    await act(() => refreshAccessRequests())
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull()
  })
})
