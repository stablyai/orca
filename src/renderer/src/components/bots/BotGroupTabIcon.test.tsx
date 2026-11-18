// @vitest-environment happy-dom

import { cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'

const mocks = vi.hoisted(() => {
  const bots: Bot[] = []
  const groups: BotGroup[] = []
  return { bots, groups }
})
vi.mock('@/lib/bot-catalog', () => ({ useBots: () => mocks.bots }))
vi.mock('@/lib/bot-group-list', () => ({ useBotGroups: () => mocks.groups }))

import { BotGroupTabIcon, useBotGroupTabMembers } from './BotGroupTabIcon'

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
    permissionMode: 'ask',
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

function group(botIds: string[]): BotGroup {
  return {
    id: 'group-1',
    name: 'triage team',
    hostId: 'local',
    revision: 1,
    folder: 'group-triage',
    folderWorkspaceId: 'fw-g',
    createdAt: 1,
    members: botIds.map((botId) => ({ botId, sessionId: `bot-group-member-${botId}` })),
    replyMode: { kind: 'mentions' }
  }
}

function faces(): string[] {
  return [...document.querySelectorAll('[data-testid="bot-group-faces"] > span')].map(
    (face) => face.textContent ?? ''
  )
}

const crew = [bot('a', 'Scout'), bot('b', 'Juno'), bot('c', 'Pip')]

afterEach(() => {
  cleanup()
  mocks.bots.length = 0
  mocks.groups.length = 0
})

describe('BotGroupTabIcon', () => {
  it("draws the group's first two members' faces, the first in front", () => {
    render(<BotGroupTabIcon members={crew} />)
    expect(faces()).toEqual(['J', 'S'])
  })

  it('keeps the group glyph until the members load', () => {
    render(<BotGroupTabIcon members={[]} />)
    expect(document.querySelector('[data-testid="bot-group-faces"]')).toBeNull()
    expect(document.querySelector('svg')).not.toBeNull()
  })
})

describe('useBotGroupTabMembers', () => {
  it("reads a room tab's members in the group's order, skipping bots not loaded", () => {
    mocks.bots.push(crew[2]!, crew[0]!)
    mocks.groups.push(group(['a', 'b', 'c']))
    const { result } = renderHook(() => useBotGroupTabMembers('group-1'))
    expect(result.current.map((member) => member.name)).toEqual(['Scout', 'Pip'])
  })

  it("reads a thread tab's members through its group", () => {
    mocks.bots.push(crew[0]!)
    mocks.groups.push({
      ...group(['a']),
      threads: [{ id: 'thread-1', createdAt: 1, members: [{ botId: 'a', sessionId: 't-a' }] }]
    })
    const { result } = renderHook(() => useBotGroupTabMembers('thread-1'))
    expect(result.current.map((member) => member.name)).toEqual(['Scout'])
  })

  it('reads nothing for a tab that is not a room', () => {
    mocks.groups.push(group(['a']))
    mocks.bots.push(crew[0]!)
    expect(renderHook(() => useBotGroupTabMembers(null)).result.current).toEqual([])
  })
})
