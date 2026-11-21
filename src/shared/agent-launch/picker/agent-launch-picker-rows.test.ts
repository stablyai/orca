import { expect, it } from 'vitest'
import { buildNewTabAgentMenuRows, type ChatProgramObservation } from './agent-launch-picker-rows'
import type { TuiAgent } from '../catalog/tui-agent'

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

const rowsFor = (detected: TuiAgent[] | null, program: ChatProgramObservation) =>
  buildNewTabAgentMenuRows({
    settings: { agentDefaultSurface: 'chat' },
    detectedOnHost: detected,
    chatAgents: ['antigravity'],
    hostChatAnswer: () => 'yes',
    chatProgram: () => program
  })

it('marks a chat as setup only when its agent is not installed on the host', () => {
  expect(rowsFor(['claude'], 'installable')).toContainEqual({
    kind: 'chat',
    agent: 'antigravity',
    setup: true
  })
  expect(rowsFor(null, 'installable')).toContainEqual({
    kind: 'chat',
    agent: 'antigravity',
    setup: true
  })
  expect(rowsFor(['claude'], 'available')).toContainEqual({ kind: 'chat', agent: 'antigravity' })
  expect(rowsFor(['antigravity'], 'unknown')).toContainEqual({
    kind: 'chat',
    agent: 'antigravity'
  })
})

it('lists chats the host runs now before chats that install their agent first', () => {
  const rows = buildNewTabAgentMenuRows({
    settings: { agentDefaultSurface: 'chat' },
    detectedOnHost: ['opencode'],
    chatAgents: ['codex', 'opencode'],
    hostChatAnswer: () => 'yes',
    chatProgram: (agent) => (agent === 'opencode' ? 'available' : 'installable'),
    offerAgentSetup: true,
    hostPlatform: 'darwin'
  })
  expect(rows).toEqual([
    { kind: 'chat', agent: 'opencode' },
    { kind: 'chat', agent: 'codex', setup: true }
  ])
})
