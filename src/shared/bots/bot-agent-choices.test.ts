import { describe, expect, it } from 'vitest'
import {
  buildNewTabAgentMenuRows,
  type NewTabAgentMenuRow
} from '../agent-launch/picker/agent-launch-picker-rows'
import { botAgentChoices, botNewChatAgents, type BotAgentMenuModel } from './bot-agent-choices'

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
