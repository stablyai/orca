import { expect, it } from 'vitest'
import { buildNewTabAgentMenuRows } from './agent-launch-picker-rows'

it('offers a runnable chat-only provider when terminal is the default', () => {
  expect(
    buildNewTabAgentMenuRows({
      settings: { agentDefaultSurface: 'terminal' },
      detectedOnHost: [],
      chatAgents: ['zcode'],
      hostChatAnswer: () => 'yes',
      chatProgram: () => 'available'
    })
  ).toEqual([{ kind: 'chat', agent: 'zcode' }])
})
