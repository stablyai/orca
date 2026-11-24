import { describe, expect, it } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { findMatchingTabAgentLaunchOptions } from '../tab-bar/create-entry/tab-agent-launch-options'
import { buildBotNewChatSearchOptions } from './bot-new-chat-search-options'

const bot: Bot = {
  id: 'release-helper',
  name: 'Release helper',
  hostId: 'local',
  folder: 'release-helper',
  folderWorkspaceId: 'fw-release-helper',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'release-helper-chat',
  createdAt: 0,
  updatedAt: 0
}

const options = buildBotNewChatSearchOptions(bot, [
  { agent: 'claude' },
  { agent: 'codex' },
  { agent: 'cursor', unavailable: 'not-on-host' },
  { agent: 'grok' }
])

const search = (query: string): string[] =>
  findMatchingTabAgentLaunchOptions(query, options).map((option) => option.label)

describe('buildBotNewChatSearchOptions', () => {
  it('finds only the side chat on the agent typed', () => {
    expect(search('codex')).toEqual(['New Codex Chat'])
    expect(search('Codex')).toEqual(['New Codex Chat'])
    expect(search('cod')).toEqual(['New Codex Chat'])
    expect(search('grok')).toEqual(['New Grok Chat'])
  })

  it('finds the side chat by any of the agent’s names', () => {
    expect(search('claude')).toEqual(['New Claude Code Chat'])
    expect(search('claude code')).toEqual(['New Claude Code Chat'])
  })

  it('never matches the Home Chat on the bot’s own agent', () => {
    expect(search('claude')).not.toContain('New Home Chat')
  })

  it('finds the Home Chat by its own name', () => {
    expect(search('home')).toEqual(['New Home Chat'])
    expect(search('new home chat')).toEqual(['New Home Chat'])
  })

  it('lists every chat for a word they share, an unavailable one last', () => {
    expect(search('chat')).toEqual([
      'New Home Chat',
      'New Claude Code Chat',
      'New Codex Chat',
      'New Grok Chat',
      'New Cursor Chat'
    ])
  })

  it('finds nothing for a word no chat has', () => {
    expect(search('readme')).toEqual([])
    // One keystroke is too little to pick an agent, as in any other workspace.
    expect(search('c')).toEqual([])
  })

  it('launches through the bot and says why a chat cannot start', () => {
    const [home, claude, , cursor] = options
    expect(home?.botChat).toEqual({ bot, agent: 'claude', home: true })
    expect(claude?.botChat).toEqual({ bot, agent: 'claude', home: false })
    expect(cursor).toMatchObject({ disabled: true, botChat: { agent: 'cursor', home: false } })
    expect(cursor?.reason).toBeTruthy()
  })
})
