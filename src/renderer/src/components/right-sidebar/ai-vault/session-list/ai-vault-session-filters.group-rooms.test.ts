// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { BotGroup } from '../../../../../../shared/bots/bot-group'
import { collapseBotGroupRoomRows, placeBotGroupRoomRows } from '@/lib/bot-group-room-history'
import { useAiVaultPanelSessions, type AiVaultRoomRows } from './ai-vault-session-filters'

const base: AiVaultSession = {
  id: 'base',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 'session',
  title: 'Room work',
  cwd: '/bots/a',
  branch: null,
  model: null,
  filePath: '/x.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-11-04T10:00:00.000Z',
  messageCount: 4,
  totalTokens: 10,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: '',
  subagent: null
}

const group: BotGroup = {
  id: 'group-1',
  name: 'triage team',
  hostId: 'local',
  revision: 1,
  folder: 'group-triage',
  folderWorkspaceId: 'fw-g',
  createdAt: 1,
  replyMode: { kind: 'mentions' },
  members: [
    { botId: 'a', sessionId: 'bot-group-member-a' },
    { botId: 'b', sessionId: 'bot-group-member-b' }
  ],
  threads: [
    {
      id: 'bot-group-thread-1',
      createdAt: 2,
      title: 'Release notes',
      members: [
        { botId: 'a', sessionId: 'bot-group-member-ta' },
        { botId: 'b', sessionId: 'bot-group-member-tb' }
      ]
    }
  ]
}

// A Claude member's older row and a Codex member's newer row of the same room.
const rows: AiVaultSession[] = [
  {
    ...base,
    id: 'codex-row',
    agent: 'codex',
    cwd: '/bots/b',
    modifiedAt: '2026-11-04T11:00:00.000Z',
    structuredSession: { sessionId: 'bot-group-member-b', workspaceId: 'fw-b' }
  },
  {
    ...base,
    id: 'claude-row',
    structuredSession: { sessionId: 'bot-group-member-a', workspaceId: 'fw-a' }
  }
]

const GROUP_HOME = '/Users/ada/.orca/bots/group-triage'
const fold: AiVaultRoomRows = {
  place: (sessions) =>
    placeBotGroupRoomRows(sessions, [group], (id) => (id === 'fw-g' ? GROUP_HOME : null)),
  fold: (sessions) => collapseBotGroupRoomRows(sessions, [group])
}
// The same bot's ordinary side chat, which stays in its own home.
const sideChat: AiVaultSession = {
  ...base,
  id: 'side-chat',
  modifiedAt: '2026-11-04T12:00:00.000Z',
  structuredSession: { sessionId: 'bot-side-chat', workspaceId: 'fw-a' }
}

function listed(sessions: AiVaultSession[], scope: 'all' | 'workspace', paths: string[]) {
  return renderHook(() =>
    useAiVaultPanelSessions(sessions, 'browse', 'agent', {
      query: '',
      agents: ['claude', 'codex'],
      scope,
      sort: 'updated',
      hideEmptySessions: false,
      activeWorktreePaths: paths,
      roomRows: fold
    })
  ).result.current.filteredSessions.map((session) => [session.id, session.cwd])
}

describe('group rooms in filtered Session History', () => {
  it('folds a room after filters run, so a matching member keeps the room listed', () => {
    const { result } = renderHook(() =>
      useAiVaultPanelSessions(rows, 'browse', 'agent', {
        query: '',
        agents: ['claude'],
        scope: 'all',
        sort: 'updated',
        hideEmptySessions: false,
        activeWorktreePaths: [],
        roomRows: fold
      })
    )
    expect(result.current.filteredSessions.map((session) => session.id)).toEqual(['claude-row'])
  })

  it("lists each room's newest member once in the group home and under All", () => {
    const threadRows = [
      {
        ...rows[1],
        id: 'thread-a',
        modifiedAt: '2026-11-04T11:30:00.000Z',
        structuredSession: { sessionId: 'bot-group-member-ta', workspaceId: 'fw-a' }
      },
      {
        ...rows[0],
        id: 'thread-b',
        structuredSession: { sessionId: 'bot-group-member-tb', workspaceId: 'fw-b' }
      }
    ]
    const formerMember = {
      ...base,
      id: 'former-member',
      modifiedAt: '2026-11-04T09:00:00.000Z',
      structuredSession: { sessionId: 'bot-group-member-gone', workspaceId: 'fw-a' }
    }
    const cli = { ...base, id: 'cli', modifiedAt: '2026-11-04T08:00:00.000Z' }
    const all = [...rows, ...threadRows, sideChat, formerMember, cli]
    expect(listed(all, 'workspace', [GROUP_HOME])).toEqual([
      ['thread-a', GROUP_HOME],
      ['codex-row', GROUP_HOME]
    ])
    expect(listed(all, 'workspace', ['/bots/a'])).toEqual([
      ['side-chat', '/bots/a'],
      ['former-member', '/bots/a'],
      ['cli', '/bots/a']
    ])
    expect(listed(all, 'all', [])).toEqual([
      ['side-chat', '/bots/a'],
      ['thread-a', GROUP_HOME],
      ['codex-row', GROUP_HOME],
      ['former-member', '/bots/a'],
      ['cli', '/bots/a']
    ])
  })
})
