import { describe, expect, it } from 'vitest'
import { buildNewTabAgentMenuRows, type HostChatAnswer } from './agent-launch-picker-rows'
import type { TuiAgent } from '../catalog/tui-agent'

function rows(input: {
  surface: 'chat' | 'terminal'
  detected: TuiAgent[]
  answer?: HostChatAnswer
  offerAgentSetup?: boolean
  hostPlatform?: string | null
  chatAgents?: TuiAgent[]
}) {
  return buildNewTabAgentMenuRows({
    settings: { agentDefaultSurface: input.surface },
    detectedOnHost: input.detected,
    chatAgents: input.chatAgents ?? ['claude', 'codex'],
    hostChatAnswer: () => input.answer ?? 'yes',
    chatProgram: (agent) => (input.detected.includes(agent) ? 'available' : 'missing'),
    offerAgentSetup: input.offerAgentSetup,
    hostPlatform: input.hostPlatform === undefined ? 'linux' : input.hostPlatform
  }).map((row) => `${row.kind}:${row.agent}`)
}

describe('new-tab rows for agents the host lacks', () => {
  it('opens setup chats for missing agents when chat is preferred', () => {
    expect(rows({ surface: 'chat', detected: ['claude'], offerAgentSetup: true })).toEqual([
      'chat:claude',
      'chat:codex'
    ])
    expect(rows({ surface: 'chat', detected: ['claude'] })).toEqual([
      'chat:claude',
      'chat-unavailable:codex'
    ])
  })

  it('offers setup chats to a terminal user only when the host has no agents', () => {
    expect(rows({ surface: 'terminal', detected: [], offerAgentSetup: true })).toEqual([
      'chat:claude',
      'chat:codex'
    ])
    expect(rows({ surface: 'terminal', detected: ['claude'], offerAgentSetup: true })).toEqual([
      'cli:claude'
    ])
  })

  it('keeps hosts without chat to their own reason', () => {
    expect(rows({ surface: 'chat', detected: [], answer: 'ssh', offerAgentSetup: true })).toEqual([
      'chat-unavailable:claude',
      'chat-unavailable:codex'
    ])
  })

  it('does not open setup for a missing agent without an installer', () => {
    expect(
      rows({ surface: 'chat', detected: [], offerAgentSetup: true, chatAgents: ['grok'] })
    ).toEqual(['chat-unavailable:grok'])
    expect(
      rows({ surface: 'terminal', detected: [], offerAgentSetup: true, chatAgents: ['grok'] })
    ).toEqual([])
  })

  it.each(['win32', null])('does not offer an installer on host platform %s', (hostPlatform) => {
    expect(rows({ surface: 'chat', detected: [], offerAgentSetup: true, hostPlatform })).toEqual([
      'chat-unavailable:claude',
      'chat-unavailable:codex'
    ])
  })
})
