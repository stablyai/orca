import { expect, it } from 'vitest'
import { buildNewTabAgentMenuRows } from './agent-launch-picker-rows'
it('offers detected Gray as a terminal agent even when chat is the default', () => {
  expect(
    buildNewTabAgentMenuRows({
      settings: { agentDefaultSurface: 'chat' },
      detectedOnHost: ['gray'],
      chatAgents: [],
      hostChatAnswer: () => 'yes',
      chatProgram: () => 'unlearned'
    })
  ).toEqual([{ kind: 'cli', agent: 'gray' }])
})
