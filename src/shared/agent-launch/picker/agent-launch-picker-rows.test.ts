import { expect, it } from 'vitest'
import { buildNewTabAgentMenuRows, type ChatProgramObservation } from './agent-launch-picker-rows'
import type { TuiAgent } from '../catalog/tui-agent'

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
