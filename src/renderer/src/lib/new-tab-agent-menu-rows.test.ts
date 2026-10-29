import { describe, expect, it } from 'vitest'
import { buildNewTabAgentMenuRows } from './new-tab-agent-menu-rows'

describe('external ACP chat rows', () => {
  it('offers host registered IDs without a matching terminal catalog entry', () => {
    const rows = buildNewTabAgentMenuRows({
      settings: { experimentalNativeChat: true },
      detectedOnHost: [],
      chatAgents: [],
      externalChatAgents: ['team-agent'],
      hostChatAnswer: () => 'yes',
      chatProgram: () => 'missing'
    })
    expect(rows).toEqual([{ kind: 'chat', agent: 'team-agent' }])
  })
})

it.each(['subfolder', 'ssh', 'not-on-host'] as const)(
  'keeps external chat unavailable for %s',
  (reason) => {
    const rows = buildNewTabAgentMenuRows({
      settings: { experimentalNativeChat: true },
      detectedOnHost: [],
      chatAgents: [],
      externalChatAgents: ['team-agent'],
      hostChatAnswer: () => reason,
      chatProgram: () => 'missing'
    })
    expect(rows).toEqual([{ kind: 'chat-unavailable', agent: 'team-agent', reason }])
  }
)

it('does not expose external ACP as a terminal when chat is disabled', () => {
  expect(
    buildNewTabAgentMenuRows({
      settings: { experimentalNativeChat: false },
      detectedOnHost: [],
      chatAgents: [],
      externalChatAgents: ['team-agent'],
      hostChatAnswer: () => 'yes',
      chatProgram: () => 'missing'
    })
  ).toEqual([])
})
