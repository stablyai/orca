// @vitest-environment happy-dom

import { withBotConnectorRuntime } from '../../../lib/bot-connector-host-calls.test-fixture'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import {
  applyBotMemberUpdates,
  type BotUpdateParams
} from '../../../../../shared/rpc-contract/bots-params'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import type { Bot, BotLinear, BotMember } from '../../../../../shared/bot-types'

const mocks = vi.hoisted(() => {
  const members: BotMember[] = []
  return { updateBot: vi.fn(), members }
})
vi.mock('@/lib/bot-catalog', () => ({
  // The host applies only the people an update adds or takes off; the list it leaves is what the test checks.
  updateBot: (botId: string, updates: BotUpdateParams['updates']) =>
    updates.permissionMode !== undefined
      ? mocks.updateBot(botId, updates)
      : mocks.updateBot(botId, {
          members: updates.members ?? applyBotMemberUpdates(mocks.members, updates)
        }),
  openBotHome: () => false,
  readBots: () => [],
  readBotsEnabled: () => true
}))
vi.mock('@/store', () => {
  const state = { openSettingsTarget: vi.fn(), openSettingsPage: vi.fn() }
  return {
    useAppStore: Object.assign(() => undefined, {
      getState: () => state,
      subscribe: () => () => {}
    })
  }
})

import { reviewAccessRequest } from '@/lib/bot-access-requests'
import { BotWhoCanAskList } from '../BotWhoCanAskList'
import { useLinearWhoCanAsk } from './use-linear-who-can-ask'

function BotLinearWhoCanAsk(props: { bot: Bot; linear: BotLinear; linked: boolean }) {
  return (
    <BotWhoCanAskList
      bot={props.bot}
      service={useLinearWhoCanAsk('local', props.linear, props.linked)}
    />
  )
}

const confirm = vi.fn()

function renderList(ui: ReactElement): void {
  render(
    <ConfirmationDialogContext.Provider value={confirm}>{ui}</ConfirmationDialogContext.Provider>
  )
}

const slackSam: BotMember = { id: 'U-sam', name: 'Sam on Slack' }
const linearBea: BotMember = {
  id: 'L-bea',
  name: 'Bea',
  source: 'linear',
  workspaceId: 'org-1'
}
const otherOrg: BotMember = {
  id: 'L-cy',
  name: 'Cy',
  source: 'linear',
  workspaceId: 'org-2'
}
const linear = { workspaceId: 'org-1', workspaceName: 'Acme' }

function bot(members: BotMember[]): Bot {
  return {
    id: 'bot-1',
    name: 'Reviewer',
    hostId: 'local',
    folder: 'reviewer',
    folderWorkspaceId: 'fw-1',
    agent: 'claude',
    avatar: null,
    paused: false,
    notifications: {
      needsPermission: true,
      taskComplete: true,
      couldNotFinish: true
    },
    members,
    slack: null,
    linear,
    github: null,
    chatSessionId: null,
    createdAt: 1,
    updatedAt: 1
  }
}

const api = { botLinear: { members: vi.fn() }, botSlack: { members: vi.fn() } }

beforeEach(() => {
  confirm.mockReset().mockResolvedValue(true)
  mocks.members = [slackSam, linearBea, otherOrg]
  mocks.updateBot.mockReset().mockResolvedValue(bot(mocks.members))
  api.botSlack.members.mockReset()
  api.botLinear.members.mockReset().mockResolvedValue({
    ok: true,
    value: {
      members: [
        { id: 'L-bea', name: 'Bea' },
        {
          id: 'L-dee',
          name: 'Dee',
          handle: 'dee',
          avatarUrl: 'https://public.linear.app/org-1/dee'
        }
      ],
      complete: true
    }
  })
  Object.assign(window, { api: withBotConnectorRuntime(api) })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

describe('useLinearWhoCanAsk', () => {
  it('lists only this Linear workspace’s people, and says outsiders get a public reply', () => {
    renderList(<BotLinearWhoCanAsk bot={bot(mocks.members)} linear={linear} linked />)

    expect(screen.getByText('Bea')).toBeDefined()
    expect(screen.queryByText('Sam on Slack')).toBeNull()
    expect(screen.queryByText('Cy')).toBeNull()
    expect(screen.getByText('Everyone else in Acme gets a public reply to ask you.')).toBeDefined()
    expect(screen.getByText('You and Bea can ask Reviewer.')).toBeDefined()
  })

  it('searches Linear only, and saves picks as this workspace’s Linear people', async () => {
    renderList(<BotLinearWhoCanAsk bot={bot(mocks.members)} linear={linear} linked />)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.change(await screen.findByPlaceholderText('Search people in Acme'), {
      target: { value: 'de' }
    })
    await waitFor(() =>
      expect(api.botLinear.members).toHaveBeenLastCalledWith({
        workspaceId: 'org-1',
        query: 'de'
      })
    )
    expect(api.botSlack.members).not.toHaveBeenCalled()

    // Their handle shows beside the name; Cy, with access in another workspace, is never listed.
    expect(await screen.findByText('dee')).toBeDefined()
    expect(screen.queryByText('Cy')).toBeNull()
    fireEvent.click(await screen.findByText('Dee'))
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 person' }))
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Give Dee access to Reviewer?',
          surface: 'security'
        })
      )
    )
    await waitFor(() =>
      expect(mocks.updateBot).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }), {
        members: [
          ...mocks.members,
          // The picture is kept for the chip; the handle isn't saved.
          {
            id: 'L-dee',
            name: 'Dee',
            avatarUrl: 'https://public.linear.app/org-1/dee',
            source: 'linear',
            workspaceId: 'org-1'
          }
        ]
      })
    )
  })

  it('removes a Linear person and leaves Slack and the other workspace alone', () => {
    renderList(<BotLinearWhoCanAsk bot={bot(mocks.members)} linear={linear} linked />)
    fireEvent.click(screen.getByRole('button', { name: /^Remove / }))

    expect(mocks.updateBot).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }), {
      members: [slackSam, otherOrg]
    })
  })

  it('offers no picker until the owner’s Linear account is linked there', () => {
    renderList(<BotLinearWhoCanAsk bot={bot(mocks.members)} linear={linear} linked={false} />)

    expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true)
    expect(
      screen.getByText('Finish setup to link your Linear account in Acme, then pick people here.')
    ).toBeDefined()
  })

  it('names a Linear requester by the email Linear verified first, since display names repeat', async () => {
    confirm.mockResolvedValue(false)
    renderList(<BotLinearWhoCanAsk bot={bot(mocks.members)} linear={linear} linked />)
    act(() =>
      reviewAccessRequest({
        hostId: 'local',
        requestId: 'req-linear',
        botId: 'bot-1',
        source: 'linear',
        workspaceId: 'org-1',
        workspaceName: 'Acme',
        requester: {
          id: 'L-pat',
          name: 'Pat',
          handle: 'pat',
          detail: 'pat@acme.dev'
        },
        createdAt: 1,
        expiresAt: 2
      })
    )
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    const [options] = confirm.mock.calls[0] ?? []
    expect(options.details.props.grant.people).toEqual([
      { id: 'L-pat', name: 'Pat', identity: 'pat@acme.dev · @pat' }
    ])
    expect(screen.getByText(/^pat@acme\.dev · @pat · /)).toBeDefined()
    expect(mocks.updateBot).not.toHaveBeenCalled()
  })
})
