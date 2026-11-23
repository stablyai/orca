// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { BotGroupMembersDialog } from './BotGroupMembersDialog'

const mocks = vi.hoisted(() => ({
  bots: new Array<Bot>(),
  openBotGroup: vi.fn(async (_group: BotGroup) => {}),
  rpc: vi.fn(async (_target: unknown, method: string, _params?: unknown) =>
    // A host answers with its own view of the group, which names itself `local`.
    method === 'bots.roster' ? { bots: [] } : { group }
  )
}))
vi.mock('@/lib/bot-catalog', () => ({ useBots: () => mocks.bots }))
vi.mock('@/lib/bot-group-catalog', () => ({ openBotGroup: mocks.openBotGroup }))
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
  mocks.openBotGroup.mockClear()
})

describe('BotGroupMembersDialog', () => {
  const sameHost = [bot('a', 'Fern'), bot('b', 'Moss'), bot('c', 'Ivy')]
  beforeEach(() => {
    mocks.bots = sameHost
  })

  it('keeps the name field focused during member selection and offers the suggestion on Tab', () => {
    render(<BotGroupMembersDialog onClose={() => {}} />)
    expect(button('Create').disabled).toBe(true)
    const name = screen.getByPlaceholderText<HTMLInputElement>('Name your group')
    name.focus()
    expect(fireEvent.mouseDown(row('Ivy'))).toBe(false)
    fireEvent.click(row('Ivy'))
    expect(document.activeElement).toBe(name)
    fireEvent.click(row('Fern'))
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
    fireEvent.click(row('Willow'))
    expect(row('Fern').hasAttribute('disabled')).toBe(true)
    expect(row('Moss').hasAttribute('disabled')).toBe(true)
    fireEvent.click(row('Willow'))
    expect(row('Fern').hasAttribute('disabled')).toBe(false)
    fireEvent.click(row('Fern'))
    fireEvent.click(row('Moss'))
    expect(row('Willow').hasAttribute('disabled')).toBe(true)
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

  it("creates a paired server's group on that server and opens it there", async () => {
    mocks.bots = [bot('w', 'Willow', 'runtime:ws'), bot('x', 'Hazel', 'runtime:ws')]
    render(<BotGroupMembersDialog onClose={() => {}} />)
    fireEvent.click(row('Willow'))
    fireEvent.click(row('Hazel'))
    fireEvent.change(screen.getByPlaceholderText('Name your group'), {
      target: { value: 'Crew' }
    })
    fireEvent.click(button('Create'))
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'ws' },
      'bots.groups.create',
      { name: 'Crew', botIds: ['w', 'x'] }
    )
    await waitFor(() => expect(mocks.openBotGroup).toHaveBeenCalled())
    expect(mocks.openBotGroup.mock.calls[0][0].hostId).toBe('runtime:ws')
  })

  it("never shows another computer's bot with the same id as picked", () => {
    mocks.bots = [bot('a', 'Fern'), bot('a', 'Willow', 'runtime:ws')]
    render(<BotGroupMembersDialog onClose={() => {}} />)
    fireEvent.click(row('Fern'))
    expect(row('Fern').getAttribute('aria-checked')).toBe('true')
    expect(row('Willow').getAttribute('aria-checked')).toBe('false')
  })
})
