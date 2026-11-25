import { describe, expect, it } from 'vitest'
import {
  buildNewTabAgentMenuRows,
  type NewTabAgentMenuRow
} from '../agent-launch/picker/agent-launch-picker-rows'
import { botHomeOffers, botNewChatAgents, type BotAgentMenuModel } from './bot-agent-choices'

const settled = (
  rows: NewTabAgentMenuRow[],
  detectedIds: string[] | null = rows.map((row) => row.agent)
): BotAgentMenuModel => ({ state: 'settled', rows, detection: { detectedIds } })

describe('botNewChatAgents', () => {
  it('lists only the agents enabled here, the bot’s own first', () => {
    const model = settled(
      [
        { kind: 'chat', agent: 'claude' },
        { kind: 'cli', agent: 'gemini', chat: true },
        { kind: 'chat-unavailable', agent: 'cursor', reason: 'not-on-host' },
        // Offers to install the agent first: not one the user has.
        { kind: 'chat', agent: 'grok', setup: true },
        { kind: 'chat', agent: 'kimi', setup: true }
      ],
      ['claude', 'gemini', 'cursor']
    )
    expect(botNewChatAgents({ agent: 'gemini' }, model)).toEqual([
      { agent: 'gemini' },
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

it('offers a shared agent one new chat on its own agent: no Home Chat, terminal or other agent', () => {
  // This computer has other agents, but the owner's host runs the chat on the agent's own.
  const model = settled([
    { kind: 'chat', agent: 'claude' },
    { kind: 'chat', agent: 'codex' }
  ])
  expect(botHomeOffers({ agent: 'codex' }, model, true)).toEqual({
    homeChat: false,
    agents: [{ agent: 'codex' }],
    workspaceTabs: false
  })
})
