import { describe, expect, it } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { botUpcomingRows } from './bot-upcoming-rows'

function makeBot(agent: Bot['agent']): Bot {
  return {
    id: `bot-${agent}`,
    name: 'Test Bot',
    hostId: 'local',
    folder: 'test-bot',
    folderWorkspaceId: 'w1',
    agent,
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

describe('botUpcomingRows', () => {
  it('shows both routines for Claude/Codex and neither for unsupported agents', () => {
    const empty = { automations: [], waits: [] }
    expect(botUpcomingRows(makeBot('claude'), empty).map((row) => row.kind)).toEqual([
      'tidy-up',
      'look-around'
    ])
    expect(botUpcomingRows(makeBot('codex'), empty).map((row) => row.kind)).toEqual([
      'tidy-up',
      'look-around'
    ])
    expect(botUpcomingRows(makeBot('cursor'), empty).map((row) => row.kind)).toEqual([])
  })
})
