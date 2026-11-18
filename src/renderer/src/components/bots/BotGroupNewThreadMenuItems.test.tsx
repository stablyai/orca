// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'

const calls = vi.hoisted(() => ({
  start: vi.fn(async (_group: { id: string }) => {}),
  toast: vi.fn()
}))
vi.mock('@/lib/bot-catalog', () => ({
  useBots: () => ['Scout', 'Juno', 'Pip'].map((name, index) => bot(`bot-${index}`, name))
}))
vi.mock('@/lib/bot-group-catalog', () => ({ startBotGroupThread: calls.start }))
vi.mock('sonner', () => ({ toast: { error: calls.toast } }))

import { BotGroupNewThreadMenuItems } from './BotGroupNewThreadMenuItems'

function bot(id: string, name: string): Bot {
  return {
    id,
    name,
    hostId: 'local',
    folder: id,
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
  name: 'triage team',
  hostId: 'local',
  revision: 1,
  folder: 'group-triage',
  folderWorkspaceId: 'fw-g',
  createdAt: 1,
  members: ['bot-0', 'bot-1', 'bot-2'].map((botId) => ({ botId, sessionId: `m-${botId}` })),
  replyMode: { kind: 'mentions' }
}

function openMenu(): void {
  render(
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger>+</DropdownMenuTrigger>
      <DropdownMenuContent>
        <BotGroupNewThreadMenuItems group={group} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BotGroupNewThreadMenuItems', () => {
  it("offers a new thread in the group, drawn with its members' faces", () => {
    openMenu()
    const item = screen.getByRole('menuitem')
    expect(item.textContent).toBe('JSNew thread in triage teamstarts fresh')
    expect(item.querySelectorAll('[data-testid="bot-group-faces"] > span')).toHaveLength(2)
  })

  it('starts the thread on the host when chosen', async () => {
    openMenu()
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem'))
    })
    expect(calls.start).toHaveBeenCalledWith(group)
  })

  it('tells the owner when a thread could not start', async () => {
    calls.start.mockRejectedValueOnce(new Error('Every bot has left this group.'))
    openMenu()
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem'))
    })
    await waitFor(() => expect(calls.toast).toHaveBeenCalledOnce())
  })
})
