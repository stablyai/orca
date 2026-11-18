// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { BotGroupMembersDialog, suggestGroupName } from './BotGroupMembersDialog'

const mocks = vi.hoisted(() => ({
  bots: new Array<Bot>(),
  rpc: vi.fn(async (_target: unknown, method: string, _params?: unknown) =>
    method === 'bots.roster' ? { bots: [] } : { group: { id: 'g' } }
  )
}))
vi.mock('@/lib/bot-catalog', () => ({ useBots: () => mocks.bots }))
vi.mock('@/lib/bot-group-catalog', () => ({ openBotGroup: vi.fn(async () => {}) }))
vi.mock('@/lib/bot-group-list', () => ({ refreshBotGroups: vi.fn(async () => {}) }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (target: unknown, method: string, params?: unknown) =>
    mocks.rpc(target, method, params)
}))
vi.mock('./use-bot-group-delete', () => ({ useBotGroupDelete: () => vi.fn() }))

function bot(id: string, name: string): Bot {
  return {
    id,
    name,
    hostId: 'local',
    folder: name.toLowerCase(),
    folderWorkspaceId: `fw-${id}`,
    agent: 'claude',
    avatar: null,
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    chatSessionId: null,
    linear: null,
    github: null,
    createdAt: 1,
    updatedAt: 1
  }
}

const group: BotGroup = {
  id: 'group-1',
  name: 'Crew',
  hostId: 'local',
  revision: 1,
  folder: 'group-crew',
  folderWorkspaceId: 'fw-g',
  createdAt: 1,
  members: [
    { botId: 'a', sessionId: 's-a' },
    { botId: 'b', sessionId: 's-b' },
    { botId: 'c', sessionId: 's-c' }
  ],
  replyMode: { kind: 'mentions' }
}

const row = (name: string) => screen.getByRole('checkbox', { name: new RegExp(name) })
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })

afterEach(() => {
  cleanup()
  mocks.rpc.mockClear()
})

describe('suggestGroupName', () => {
  // The decision is shared with the phone (bot-group-pick); this checks the desktop wording.
  it('names two, three, then two and a count', () => {
    expect(suggestGroupName(['Fern'])).toBeNull()
    expect(suggestGroupName(['Fern', 'Moss'])).toBe('Fern & Moss')
    expect(suggestGroupName(['Fern', 'Moss', 'Ivy'])).toBe('Fern, Moss & Ivy')
    expect(suggestGroupName(['Fern', 'Moss', 'Ivy', 'Sage', 'Pip'])).toBe('Fern, Moss & 3 more')
  })
})

describe('BotGroupMembersDialog', () => {
  mocks.bots = [bot('a', 'Fern'), bot('b', 'Moss'), bot('c', 'Ivy')]

  it('keeps focus in the name field when a member is picked with the pointer', () => {
    render(<BotGroupMembersDialog onClose={() => {}} />)
    const name = screen.getByPlaceholderText<HTMLInputElement>('Name your group')
    name.focus()
    // fireEvent returns false when a handler called preventDefault, which keeps focus where it was.
    expect(fireEvent.mouseDown(row('Fern'))).toBe(false)
  })

  it('creates once there is a name and two bots, offering the suggestion on Tab', () => {
    render(<BotGroupMembersDialog onClose={() => {}} />)
    expect(button('Create').disabled).toBe(true)
    expect(screen.getByText('Pick 2 or more bots')).toBeTruthy()
    fireEvent.click(row('Fern'))
    fireEvent.click(row('Ivy'))
    expect(screen.getByText('Name the group')).toBeTruthy()
    const name = screen.getByPlaceholderText<HTMLInputElement>('Name your group')
    fireEvent.keyDown(name, { key: 'Tab' })
    expect(name.value).toBe('Fern & Ivy')
    expect(button('Create').disabled).toBe(false)
    fireEvent.click(button('Create'))
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'bots.groups.create', {
      name: 'Fern & Ivy',
      botIds: ['a', 'c']
    })
  })

  it('saves an existing one-member room under a new name', () => {
    render(
      <BotGroupMembersDialog
        group={{ ...group, members: [{ botId: 'a', sessionId: 's-a' }] }}
        onClose={() => {}}
      />
    )
    fireEvent.change(screen.getByPlaceholderText('Name your group'), {
      target: { value: 'Solo' }
    })
    expect(button('Save').disabled).toBe(false)
  })

  it('edits with the members picked and saves only a change', () => {
    render(<BotGroupMembersDialog group={group} onClose={() => {}} />)
    expect(row('Moss').getAttribute('aria-checked')).toBe('true')
    expect(button('Save').disabled).toBe(true)
    fireEvent.click(row('Moss'))
    expect(button('Save').disabled).toBe(false)
    fireEvent.click(row('Moss'))
    expect(button('Save').disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText('Name your group'), {
      target: { value: 'Crew two' }
    })
    fireEvent.click(button('Save'))
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'bots.groups.update', {
      groupId: 'group-1',
      revision: 1,
      name: 'Crew two',
      botIds: ['a', 'b', 'c']
    })
  })
})
