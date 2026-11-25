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

it('offers a shared agent its owner’s agents, its own first, and no terminal or browser', () => {
  // This computer's own agents don't matter: the chat runs on the owner's.
  const here = settled([{ kind: 'chat', agent: 'claude' }])
  const ownerAgents = [{ agent: 'claude' as const }, { agent: 'codex' as const }]
  expect(botHomeOffers({ agent: 'codex' }, here, { ownerAgents })).toEqual({
    agents: [{ agent: 'codex' }, { agent: 'claude' }],
    workspaceTabs: false
  })
  // Until the owner's computer answers, the agent's own.
  expect(botHomeOffers({ agent: 'codex' }, here, { ownerAgents: null }).agents).toEqual([
    { agent: 'codex' }
  ])
})
