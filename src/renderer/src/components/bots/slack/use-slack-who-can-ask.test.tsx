// @vitest-environment happy-dom

import { withBotConnectorRuntime } from '../../../lib/bot-connector-host-calls.test-fixture'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import {
  applyBotMemberUpdates,
  type BotUpdateParams
} from '../../../../../shared/rpc-contract/bots-params'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot, BotMember } from '../../../../../shared/bot-types'

const mocks = vi.hoisted(() => {
  const members: BotMember[] = []
  return { updateBot: vi.fn(), members }
})
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
        })
}))

vi.mock('@/store', () => {
  const state = {
    setContextualToursBlockingSurfaceVisible: vi.fn(),
    settings: null
  }
  return {
    useAppStore: Object.assign(
      (selector: (current: Record<string, unknown>) => unknown) => selector(state),
      { getState: () => state }
    )
  }
})

import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import { botMembersFullError } from '../../../../../shared/bots/bot-member-capacity'
import { BotWhoCanAskList } from '../BotWhoCanAskList'
import { useSlackWhoCanAsk } from './use-slack-who-can-ask'

function BotWhoCanAsk({ bot }: { bot: Bot }): React.JSX.Element {
  return <BotWhoCanAskList bot={bot} service={useSlackWhoCanAsk(bot)} />
}

function renderList(ui: ReactElement): void {
  render(<ConfirmationDialogProvider>{ui}</ConfirmationDialogProvider>)
}

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    name: 'Reviewer',
    hostId: 'local',
    folder: 'reviewer',
    folderWorkspaceId: 'fw-1',
    agent: 'claude',
    avatar: null,
    paused: false,
    permissionMode: 'ask',
    notifications: {
      needsPermission: true,
      taskComplete: true,
      couldNotFinish: true
    },
    members: [{ id: 'U-sam', name: 'Sam Lee' }],
    slack: { appId: 'A1', teamId: 'T1' },
    chatSessionId: null,
    linear: null,
    github: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

const installed = {
  ok: true,
  value: {
    state: 'installed',
    teamId: 'T1',
    teamName: 'Globex',
    appId: 'A1',
    botUserId: 'UB',
    installerUserId: 'UI'
  }
}
const api = { state: vi.fn(), members: vi.fn() }

beforeEach(() => {
  mocks.updateBot.mockReset().mockResolvedValue(bot())
  mocks.members = bot().members
  api.state.mockReset().mockResolvedValue(installed)
  api.members.mockReset().mockResolvedValue({
    ok: true,
    value: {
      members: [
        {
          id: 'U-jane',
          name: 'Jane Doe',
          avatarUrl: 'https://avatars.slack-edge.com/jane_72.png'
        },
        { id: 'U-sam', name: 'Sam Lee' },
        { id: 'U-priya', name: 'Priya Shah' }
      ],
      complete: false
    }
  })
  Object.assign(window, { api: withBotConnectorRuntime({ botSlack: api }) })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

describe('useSlackWhoCanAsk', () => {
  async function pickJane(): Promise<void> {
    renderList(<BotWhoCanAsk bot={bot()} />)
    const addPeople = screen.getByRole('button', { name: 'Add' })
    await waitFor(() => expect(addPeople).toHaveProperty('disabled', false))
    fireEvent.click(addPeople)
    fireEvent.change(await screen.findByPlaceholderText('Search people in Globex'), {
      target: { value: ' ja ' }
    })
    await waitFor(() =>
      expect(api.members).toHaveBeenLastCalledWith({
        botId: 'bot-1',
        query: 'ja'
      })
    )
    fireEvent.click(await screen.findByText('Jane Doe'))
  }

  it('searches the workspace, then asks before giving the picked people access', async () => {
    await pickJane()
    // Someone who can already ask is listed under Can ask, and can't be picked again.
    expect(screen.getByRole('option', { name: 'Priya Shah' })).toBeDefined()
    expect(screen.getByRole('option', { name: /Sam Lee/ })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('option', { name: /Jane Doe/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('1 selected')).toBeDefined()
    expect(
      screen.getByText('Not everyone is listed. Search by name to find someone.')
    ).toBeDefined()

    fireEvent.click(screen.getByRole('option', { name: 'Priya Shah' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 people' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeVisible()
    expect(dialog).toHaveAccessibleDescription()
    // Nothing is saved until the owner confirms.
    expect(mocks.updateBot).not.toHaveBeenCalled()
    // Enter must not grant access by accident.
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    )

    fireEvent.click(within(dialog).getByRole('button', { name: 'Give access' }))
    await waitFor(() =>
      expect(mocks.updateBot).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }), {
        members: [
          { id: 'U-sam', name: 'Sam Lee' },
          // Kept with them, so their chip shows the picture Slack gave.
          {
            id: 'U-jane',
            name: 'Jane Doe',
            avatarUrl: 'https://avatars.slack-edge.com/jane_72.png',
            source: 'slack'
          },
          { id: 'U-priya', name: 'Priya Shah', source: 'slack' }
        ]
      })
    )
  })

  it('adds nobody when the owner cancels the confirmation', async () => {
    await pickJane()
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 person' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mocks.updateBot).not.toHaveBeenCalled()
  })

  async function openPicker(): Promise<HTMLElement> {
    renderList(<BotWhoCanAsk bot={bot()} />)
    const addPeople = screen.getByRole('button', { name: 'Add' })
    await waitFor(() => expect(addPeople).toHaveProperty('disabled', false))
    fireEvent.click(addPeople)
    return await screen.findByPlaceholderText('Search people in Globex')
  }

  it('shows the owner and people with access greyed under Can ask, never offered', async () => {
    api.members.mockResolvedValue({
      ok: true,
      value: {
        members: [
          { id: 'UI', name: 'Alice' },
          { id: 'U-sam', name: 'Sam Lee' },
          { id: 'U-jane', name: 'Jane Doe' }
        ],
        complete: true
      }
    })
    await openPicker()
    expect(await screen.findByText('People in Globex')).toBeDefined()
    expect(screen.getByRole('option', { name: /Jane Doe/ })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    )
    expect(screen.getByRole('option', { name: /^You/ })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('option', { name: /Alice/ })).toBeNull()
    expect(screen.getByRole('option', { name: /Sam Lee/ })).toHaveAttribute('aria-disabled', 'true')
  })

  it('keeps ticked people on screen under Selected when the search moves on', async () => {
    await pickJane()
    api.members.mockResolvedValue({ ok: true, value: { members: [], complete: true } })
    fireEvent.change(screen.getByPlaceholderText('Search people in Globex'), {
      target: { value: 'zoe' }
    })
    expect(await screen.findByText('No one named “zoe” in Globex')).toBeDefined()
    expect(screen.getByText('Selected')).toBeDefined()
    const jane = screen.getByRole('option', { name: /Jane Doe/ })
    expect(jane).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('1 selected')).toBeDefined()
    fireEvent.click(jane)
    await waitFor(() => expect(screen.queryByText('Selected')).toBeNull())
    expect(screen.queryByText('1 selected')).toBeNull()
  })

  it('shows four people after the owner, then the rest in place from +N', () => {
    const many = ['Ana', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay'].map((name) => ({
      id: `U-${name}`,
      name
    }))
    renderList(<BotWhoCanAsk bot={bot({ members: many })} />)
    expect(screen.getByText(/^Who can ask Reviewer/)).toHaveTextContent(/^Who can ask Reviewer$/)
    expect(screen.getByText('Dee')).toBeDefined()
    expect(screen.queryByText('Eli')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }))
    expect(screen.getByText('Eli')).toBeDefined()
    expect(screen.getByText('Fay')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Show 2 more' })).toBeNull()
  })

  it('removes someone who could ask', () => {
    renderList(<BotWhoCanAsk bot={bot()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Remove / }))
    expect(mocks.updateBot).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }), {
      members: []
    })
  })

  it('lists and removes only Slack people, leaving another service’s alone', () => {
    const discord = { id: 'U-sam', name: 'Sam on Discord', source: 'discord' }
    const linear = {
      id: 'U-sam',
      name: 'Sam on Linear',
      source: 'linear',
      workspaceId: 'org-1'
    }
    mocks.members = [{ id: 'U-sam', name: 'Sam Lee' }, discord, linear]
    renderList(<BotWhoCanAsk bot={bot({ members: mocks.members })} />)
    expect(screen.queryByText('Sam on Discord')).toBeNull()
    expect(screen.queryByText('Sam on Linear')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Remove / }))
    expect(mocks.updateBot).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }), {
      members: [discord, linear]
    })
  })

  it('offers no picker until the bot is installed in Slack', async () => {
    api.state.mockResolvedValue({ ok: true, value: { state: 'not_created' } })
    renderList(<BotWhoCanAsk bot={bot({ id: 'bot-2', slack: null })} />)
    await waitFor(() => expect(api.state).toHaveBeenCalledWith({ botId: 'bot-2' }))
    expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true)
    expect(
      screen.getByText('Add Reviewer to Slack first to pick people from your workspace.')
    ).toBeDefined()
    expect(screen.getByText('You and Sam Lee can ask Reviewer.')).toBeDefined()
  })

  it('keeps the picked people when a save fails, and saves them on Try again without asking again', async () => {
    mocks.updateBot.mockRejectedValueOnce(new Error('Slack did not answer.'))
    await pickJane()
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 person' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Give access' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Couldn’t add Jane Doe.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(mocks.updateBot).toHaveBeenCalledTimes(2))
    expect(mocks.updateBot).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'bot-1' }), {
      members: [
        { id: 'U-sam', name: 'Sam Lee' },
        {
          id: 'U-jane',
          name: 'Jane Doe',
          avatarUrl: 'https://avatars.slack-edge.com/jane_72.png',
          source: 'slack'
        }
      ]
    })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('advises before sharing a Full access bot, and its fixes apply at once', async () => {
    renderList(<BotWhoCanAsk bot={bot({ permissionMode: 'full-access' })} />)
    expect(screen.getByText('You and Sam Lee can ask Reviewer.')).toBeDefined()
    const advice = screen.getByRole('region', { name: 'Before you share' })
    expect(within(advice).getByText('Keep Reviewer to yourself')).toBeDefined()
    expect(within(advice).queryByText('Turn off Google for Reviewer')).toBeNull()

    fireEvent.click(within(advice).getByRole('button', { name: 'Switch' }))
    await waitFor(() =>
      expect(mocks.updateBot).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }), {
        permissionMode: 'ask'
      })
    )
    expect(
      await within(advice).findByText('New conversations start in Ask for approval.')
    ).toBeDefined()
    fireEvent.click(within(advice).getByRole('button', { name: 'Undo' }))
    await waitFor(() =>
      expect(mocks.updateBot).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'bot-1' }), {
        permissionMode: 'full-access'
      })
    )

    fireEvent.click(within(advice).getByRole('button', { name: 'Keep only me' }))
    await waitFor(() =>
      expect(mocks.updateBot).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'bot-1' }), {
        members: []
      })
    )
  })

  it('Keep only me takes off only this list’s people, never restoring someone revoked meanwhile', async () => {
    const bea = { id: 'L-bea', name: 'Bea', source: 'linear', workspaceId: 'org-1' }
    // This window still shows Bea on Linear; the phone has already taken her off on the host.
    mocks.members = [{ id: 'U-sam', name: 'Sam Lee' }]
    const shown = bot({ permissionMode: 'full-access', members: [...mocks.members, bea] })
    renderList(<BotWhoCanAsk bot={shown} />)

    fireEvent.click(screen.getByRole('button', { name: 'Keep only me' }))
    await waitFor(() =>
      expect(mocks.updateBot).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'bot-1' }), {
        members: []
      })
    )
  })

  it('adds to the people the host has now, never restoring someone revoked meanwhile', async () => {
    // Sam shows here, but was removed elsewhere before Jane is added.
    mocks.members = []
    await pickJane()
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 person' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Give access' }))
    await waitFor(() =>
      expect(mocks.updateBot).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }), {
        members: [
          {
            id: 'U-jane',
            name: 'Jane Doe',
            avatarUrl: 'https://avatars.slack-edge.com/jane_72.png',
            source: 'slack'
          }
        ]
      })
    )
  })

  it('offers Undo after Keep only me, which asks again before giving access back', async () => {
    const shown = bot({ permissionMode: 'full-access' })
    const view = render(
      <ConfirmationDialogProvider>
        <BotWhoCanAsk bot={shown} />
      </ConfirmationDialogProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Keep only me' }))
    await waitFor(() =>
      expect(mocks.updateBot).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'bot-1' }), {
        members: []
      })
    )
    view.rerender(
      <ConfirmationDialogProvider>
        <BotWhoCanAsk bot={{ ...shown, members: [] }} />
      </ConfirmationDialogProvider>
    )

    expect(await screen.findByText('Removed Sam Lee.')).toBeDefined()
    mocks.updateBot.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await screen.findByRole('dialog')
    expect(mocks.updateBot).not.toHaveBeenCalled()
  })

  it('says who wasn’t added and why when the host refuses an add at a limit', async () => {
    mocks.updateBot.mockRejectedValueOnce(
      botMembersFullError({ scope: 'bot', limit: 200, names: ['Jane Doe'] })
    )
    await pickJane()
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 person' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Give access' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nobody was added: Jane Doe would go past the 200 people a bot can have.'
    )
  })
})
