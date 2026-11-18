// @vitest-environment happy-dom

import { withBotConnectorRuntime } from '../../../lib/bot-connector-host-calls.test-fixture'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import {
  applyBotMemberUpdates,
  type BotUpdateParams
} from '../../../../../shared/rpc-contract/bots-params'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import type { Bot, BotMember } from '../../../../../shared/bot-types'

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
        })
}))

import { BotWhoCanAskList } from '../BotWhoCanAskList'
import { useGitHubWhoCanAsk } from './use-github-who-can-ask'

function BotGitHubWhoCanAsk(props: { bot: Bot; linked: boolean }) {
  return <BotWhoCanAskList bot={props.bot} service={useGitHubWhoCanAsk('local', props.linked)} />
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
const octocat: BotMember = { id: '583231', name: 'octocat', source: 'github' }

function bot(members: BotMember[]): Bot {
  return {
    id: 'bot-1',
    name: 'Ranger',
    hostId: 'local',
    folder: 'ranger',
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
    linear: null,
    github: null,
    chatSessionId: null,
    createdAt: 1,
    updatedAt: 1
  }
}

const api = { botGitHub: { users: vi.fn() }, botLinear: { members: vi.fn() } }

beforeEach(() => {
  confirm.mockReset().mockResolvedValue(true)
  mocks.members = [slackSam, linearBea, octocat]
  mocks.updateBot.mockReset().mockResolvedValue(bot(mocks.members))
  api.botLinear.members.mockReset()
  api.botGitHub.users.mockReset().mockResolvedValue({
    ok: true,
    value: { members: [{ id: '9919', name: 'hubot' }], complete: true }
  })
  Object.assign(window, { api: withBotConnectorRuntime(api) })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

describe('useGitHubWhoCanAsk', () => {
  it('lists only GitHub people, and says outsiders get a public reply', () => {
    renderList(<BotGitHubWhoCanAsk bot={bot(mocks.members)} linked />)

    expect(screen.getByText('octocat')).toBeDefined()
    expect(screen.queryByText('Sam on Slack')).toBeNull()
    expect(screen.queryByText('Bea')).toBeNull()
    expect(
      screen.getByText('Everyone else on GitHub gets a public reply to ask you.')
    ).toBeDefined()
    expect(screen.getByText('You and octocat can ask Ranger.')).toBeDefined()
  })

  it('finds people by GitHub username and saves them by numeric id', async () => {
    renderList(<BotGitHubWhoCanAsk bot={bot(mocks.members)} linked />)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    // GitHub can't list people, so an empty box asks for a username.
    expect(await screen.findByText('Type a GitHub username')).toBeDefined()
    fireEvent.change(await screen.findByPlaceholderText('Search by GitHub username'), {
      target: { value: 'hubot' }
    })
    await waitFor(() => expect(api.botGitHub.users).toHaveBeenLastCalledWith({ query: 'hubot' }))
    expect(api.botLinear.members).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByText('hubot'))
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 person' }))
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Give hubot access to Ranger?',
          surface: 'security'
        })
      )
    )
    await waitFor(() =>
      expect(mocks.updateBot).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }), {
        members: [...mocks.members, { id: '9919', name: 'hubot', source: 'github' }]
      })
    )
  })

  it('removes a GitHub person and leaves Slack and Linear alone', () => {
    renderList(<BotGitHubWhoCanAsk bot={bot(mocks.members)} linked />)
    fireEvent.click(screen.getByRole('button', { name: /^Remove / }))

    expect(mocks.updateBot).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }), {
      members: [slackSam, linearBea]
    })
  })

  it('offers no picker until setup is finished', () => {
    renderList(<BotGitHubWhoCanAsk bot={bot(mocks.members)} linked={false} />)

    expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true)
    expect(
      screen.getByText('Finish setup to link your GitHub account, then pick people here.')
    ).toBeDefined()
  })
})
