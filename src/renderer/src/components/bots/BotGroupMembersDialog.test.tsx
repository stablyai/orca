// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { BotGroupMembersDialog } from './BotGroupMembersDialog'

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
vi.mock('./use-bot-host-label', () => ({
  useBotHostLabel: (hostId: string) => (hostId === 'local' ? null : 'Workstation')
}))

// A paired server's bot is stamped with its server's host id, as the catalog lists it.
function bot(id: string, name: string, hostId: ExecutionHostId = 'local'): Bot {
  return stampBotHost(hostId, {
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
  })
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
    { botId: 'b', sessionId: 's-b' }
  ],
  replyMode: { kind: 'mentions' }
}

const row = (name: string) => screen.getByRole('checkbox', { name: new RegExp(name) })
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })

afterEach(() => {
  cleanup()
  mocks.rpc.mockClear()
})

describe('BotGroupMembersDialog', () => {
  const sameHost = [bot('a', 'Fern'), bot('b', 'Moss'), bot('c', 'Ivy')]
  beforeEach(() => {
    mocks.bots = sameHost
  })

  it('keeps the name field focused during member selection and offers the suggestion on Tab', () => {
    render(<BotGroupMembersDialog onClose={() => {}} />)
    expect(button('Create').disabled).toBe(true)
    expect(screen.getByText('Pick 2 or more bots')).toBeTruthy()
    const name = screen.getByPlaceholderText<HTMLInputElement>('Name your group')
    name.focus()
    expect(fireEvent.mouseDown(row('Ivy'))).toBe(false)
    fireEvent.click(row('Ivy'))
    expect(document.activeElement).toBe(name)
    expect(screen.getByText('Pick 2 or more bots')).toBeTruthy()
    fireEvent.click(row('Fern'))
    expect(screen.getByText('Name the group')).toBeTruthy()
    fireEvent.keyDown(name, { key: 'Tab' })
    expect(name.value).toBe('Ivy & Fern')
    expect(button('Create').disabled).toBe(false)
    fireEvent.click(button('Create'))
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'bots.groups.create', {
      name: 'Ivy & Fern',
      botIds: ['c', 'a']
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
    fireEvent.click(row('Fern'))
    expect(button('Save').disabled).toBe(true)
    fireEvent.click(row('Fern'))
    expect(button('Save').disabled).toBe(false)
  })

  it('only saves changes and puts new picks after saved members', () => {
    render(<BotGroupMembersDialog group={group} onClose={() => {}} />)
    expect(row('Moss').getAttribute('aria-checked')).toBe('true')
    expect(button('Save').disabled).toBe(true)
    fireEvent.click(row('Moss'))
    expect(button('Save').disabled).toBe(false)
    fireEvent.click(row('Moss'))
    expect(button('Save').disabled).toBe(true)
    fireEvent.click(row('Fern'))
    fireEvent.click(row('Ivy'))
    fireEvent.click(row('Fern'))
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

  it("keeps another computer's bots listed but unpickable once a member is picked", () => {
    mocks.bots = [bot('a', 'Fern'), bot('w', 'Willow', 'runtime:ws'), bot('b', 'Moss')]
    render(<BotGroupMembersDialog onClose={() => {}} />)
    expect(row('Willow').textContent).toContain('Workstation')
    expect(row('Fern').textContent).toContain('Local')
    fireEvent.click(row('Willow'))
    expect(row('Fern').hasAttribute('disabled')).toBe(true)
    expect(row('Moss').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Bots in a group must be on the same computer.')).toBeTruthy()
    fireEvent.click(row('Willow'))
    expect(row('Fern').hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText('Bots in a group must be on the same computer.')).toBeNull()
    fireEvent.click(row('Fern'))
    fireEvent.click(row('Moss'))
    expect(row('Willow').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Name the group')).toBeTruthy()
  })

  it('shows no computer names or note when every bot is on one computer', () => {
    render(<BotGroupMembersDialog onClose={() => {}} />)
    fireEvent.click(row('Fern'))
    expect(row('Moss').hasAttribute('disabled')).toBe(false)
    expect(row('Moss').textContent).not.toContain('Local')
    expect(screen.queryByText('Bots in a group must be on the same computer.')).toBeNull()
  })

  it("keeps another computer's bots unpickable while managing a group", () => {
    mocks.bots = [...sameHost, bot('w', 'Willow', 'runtime:ws')]
    render(<BotGroupMembersDialog group={group} onClose={() => {}} />)
    expect(row('Willow').hasAttribute('disabled')).toBe(true)
    expect(row('Willow').getAttribute('aria-describedby')).toBe('bot-group-same-computer')
    fireEvent.click(row('Ivy'))
    fireEvent.click(button('Save'))
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'bots.groups.update', {
      groupId: 'group-1',
      revision: 1,
      name: 'Crew',
      botIds: ['a', 'b', 'c']
    })
  })
})
