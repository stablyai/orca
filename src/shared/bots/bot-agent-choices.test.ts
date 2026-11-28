import { describe, expect, it } from 'vitest'
import {
  buildNewTabAgentMenuRows,
  type NewTabAgentMenuRow
} from '../agent-launch/picker/agent-launch-picker-rows'
import {
  botAgentChoices,
  botNewChatAgents,
  newBotAgent,
  readyBotDefaultAgent,
  type BotAgentMenuModel
} from './bot-agent-choices'

const settled = (
  rows: NewTabAgentMenuRow[],
  detectedIds: string[] | null = rows.map((row) => row.agent)
): BotAgentMenuModel => ({ state: 'settled', rows, detection: { detectedIds } })

describe('botNewChatAgents', () => {
  it('lists only the agents enabled here, the bot’s own first', () => {
    const model = settled(
      [
        { kind: 'chat', agent: 'claude' },
        { kind: 'cli', agent: 'droid', chat: true },
        { kind: 'chat-unavailable', agent: 'cursor', reason: 'not-on-host' },
        // Offers to install the agent first: not one the user has.
        { kind: 'chat', agent: 'grok', setup: true },
        { kind: 'chat', agent: 'kimi', setup: true }
      ],
      ['claude', 'droid', 'cursor']
    )
    expect(botNewChatAgents({ agent: 'droid' }, model)).toEqual([
      { agent: 'droid' },
      { agent: 'claude' },
      { agent: 'cursor', unavailable: 'not-on-host' }
    ])
  })

  it('leaves out agents disabled in Agent settings', () => {
    const rows = buildNewTabAgentMenuRows({
      settings: { disabledTuiAgents: ['codex'] },
      detectedOnHost: ['claude', 'codex'],
      chatAgents: ['claude', 'codex'],
      hostChatAnswer: () => 'yes',
      chatProgram: () => 'available'
    })
    const agents = botNewChatAgents({ agent: 'claude' }, settled(rows, ['claude', 'codex'])).map(
      (entry) => entry.agent
    )
    expect(agents).toContain('claude')
    expect(agents).not.toContain('codex')
  })

  it('falls back to the bot’s own agent when none is enabled', () => {
    const setupOnly = settled([{ kind: 'chat', agent: 'grok', setup: true }], [])
    expect(botNewChatAgents({ agent: 'claude' }, setupOnly)).toEqual([
      { agent: 'claude', unavailable: 'not-installed' }
    ])
    expect(botNewChatAgents({ agent: 'claude' }, settled([], null))).toEqual([
      { agent: 'claude', unavailable: 'check-failed' }
    ])
  })
})

describe('botAgentChoices', () => {
  it('never offers an agent the host lacks as the first choice when installed agents are required', () => {
    // A WSL distro without Linux agents: only chats that would install one first.
    const setupOnly = settled(
      [
        { kind: 'chat', agent: 'grok', setup: true },
        { kind: 'chat', agent: 'claude', setup: true }
      ],
      []
    )
    expect(botAgentChoices(setupOnly, undefined, true)).toEqual([])
    const mixed = settled([
      { kind: 'chat', agent: 'claude', setup: true },
      { kind: 'cli', agent: 'codex', chat: true }
    ])
    expect(botAgentChoices(mixed, undefined, true)).toEqual(['codex'])
  })
})

describe('readyBotDefaultAgent', () => {
  it('keeps a ready default, not one whose chat installs it first', () => {
    const model = settled([
      { kind: 'chat', agent: 'claude' },
      { kind: 'chat', agent: 'codex', setup: true }
    ])
    const choices = botAgentChoices(model)
    expect(newBotAgent(choices, readyBotDefaultAgent(model, 'codex'))).toBe('claude')
    expect(newBotAgent(choices, readyBotDefaultAgent(model, 'claude'))).toBe('claude')
    const ready = settled([
      { kind: 'chat', agent: 'claude' },
      { kind: 'cli', agent: 'codex', chat: true }
    ])
    expect(newBotAgent(botAgentChoices(ready), readyBotDefaultAgent(ready, 'codex'))).toBe('codex')
    // Antigravity is listed before Grok, but a new bot without a ready default still gets Grok.
    expect(newBotAgent(['antigravity', 'grok'], undefined)).toBe('grok')
  })
})
