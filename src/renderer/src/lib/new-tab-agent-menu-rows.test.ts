import { expect, it } from 'vitest'
import type { TuiAgent } from '../../../shared/tui-agent'
import { buildNewTabAgentMenuRows } from './new-tab-agent-menu-rows'
const disabledTuiAgents: TuiAgent[] = ['pi']
const input = {
  settings: { experimentalNativeChat: true, disabledTuiAgents },
  detectedOnHost: ['claude', 'gemini'] as const,
  chatAgents: ['claude', 'codex', 'pi'] as const,
  hostChatAnswer: () => 'yes' as const
}
it('orders enabled chats, unavailable providers and CLI rows', () => {
  expect(buildNewTabAgentMenuRows(input)).toEqual([
    { kind: 'chat', agent: 'claude' },
    { kind: 'chat-unavailable', agent: 'codex', reason: 'not-installed' },
    { kind: 'cli', agent: 'gemini' }
  ])
})
it.each([true, false])('uses workspace installation for unchosen agents: %s', (installed) => {
  expect(
    buildNewTabAgentMenuRows({
      ...input,
      detectedOnHost: installed ? ['opencode'] : [],
      chatAgents: ['opencode']
    })
  ).toEqual(installed ? [{ kind: 'chat', agent: 'opencode' }] : [])
})

it('offers a Desktop-only chat program when Chat UI is off', () => {
  expect(
    buildNewTabAgentMenuRows({
      ...input,
      settings: { experimentalNativeChat: false, disabledTuiAgents },
      detectedOnHost: ['claude'],
      chatAgents: ['zcode'],
      hostChatAnswer: (agent) => (agent === 'zcode' ? 'yes' : 'no-chats'),
      chatProgramAvailable: (agent) => agent === 'zcode'
    })
  ).toEqual([
    { kind: 'chat', agent: 'zcode' },
    { kind: 'terminal', agent: 'claude' }
  ])
})

it('offers a chat when its program exists without its terminal CLI', () => {
  expect(
    buildNewTabAgentMenuRows({
      ...input,
      detectedOnHost: [],
      chatAgents: ['zcode'],
      hostChatAnswer: (agent) => (agent === 'zcode' ? 'yes' : 'no-chats'),
      chatProgramAvailable: (agent) => agent === 'zcode'
    })
  ).toEqual([{ kind: 'chat', agent: 'zcode' }])
})
