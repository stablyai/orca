import { expect, it } from 'vitest'
import {
  codexLiveSubagents,
  codexSubagentItem,
  codexSubagentProviderFrame
} from './codex-subagent-items'
import { projectStructuredItemToNativeChat } from './structured-agent-session-projection'
import type { NativeChatMessage, NativeChatSubagentState } from './native-chat-types'

const started = {
  type: 'subAgentActivity',
  id: 'call-1',
  kind: 'started',
  agentThreadId: 'child-1',
  agentPath: '/root/reviewer'
}
function message(input: unknown, timestamp = 1000): NativeChatMessage {
  const call = codexSubagentItem(input)!
  return {
    id: String(timestamp),
    role: 'assistant',
    source: 'transcript',
    timestamp,
    blocks: [{ type: 'tool-call', name: call.name, input: call.input, state: call.state }]
  }
}

it('retains a child across control calls and settles only explicit child lifecycle evidence', () => {
  const wait = { type: 'collabAgentToolCall', tool: 'wait', status: 'completed', agentsStates: {} }
  expect(codexLiveSubagents([message(started), message(wait, 2000)])).toMatchObject([
    { id: 'child-1', state: 'working', startedAt: 1000, agentType: 'reviewer' }
  ])
  for (const kind of ['completed', 'interrupted']) {
    expect(codexLiveSubagents([message(started), message({ ...started, kind }, 3000)])).toEqual([])
  }
  const states = { ...wait, agentsStates: { 'child-2': { status: 'running' } } }
  expect(codexLiveSubagents([message(states)])).toMatchObject([{ id: 'child-2' }])
  expect(
    codexLiveSubagents([
      message(states),
      message({ ...states, agentsStates: { 'child-2': { status: 'completed' } } }, 2000)
    ])
  ).toEqual([])
})

it('projects old complete provider frames without hiding unknown or truncated diagnostics', () => {
  const frame = {
    provider: 'codex',
    kind: 'item:subAgentActivity',
    payload: {
      head: JSON.stringify(started),
      truncated: false,
      byteLength: 100,
      digest: 'd'
    }
  }
  expect(codexSubagentProviderFrame(frame)?.name).toBe('subagent_activity')
  const projected = projectStructuredItemToNativeChat({
    itemId: 'old-1',
    revision: 1,
    sequence: 1,
    observedAt: 1000,
    body: { kind: 'status', text: 'codex · item:subAgentActivity', providerFrame: frame }
  })!
  expect(projected.blocks[0]).toMatchObject({ type: 'tool-call', name: 'subagent_activity' })
  expect(codexLiveSubagents([projected])).toHaveLength(1)
  expect(codexSubagentProviderFrame({ ...frame, kind: 'notification:warning' })).toBeNull()
  expect(
    codexSubagentProviderFrame({ ...frame, payload: { ...frame.payload, truncated: true } })
  ).toBeNull()
  expect(codexSubagentItem({ ...started, agentThreadId: '../../other' })).toBeNull()
  expect(codexSubagentItem({ ...started, kind: 'future' })).toBeNull()
})

it('reads current rosters without treating a child roster as the parent roster', () => {
  const roster = (state: NativeChatSubagentState): NativeChatMessage => ({
    id: 'roster',
    role: 'system',
    source: 'transcript',
    timestamp: 2000,
    blocks: [
      {
        type: 'subagent-group',
        groupId: 'turn-1',
        agents: [{ id: 'child-1', label: 'Reviewer', state, startedAt: 1000 }]
      }
    ]
  })
  expect(codexLiveSubagents([roster('working')])).toEqual([
    { id: 'child-1', description: 'Reviewer', state: 'working', startedAt: 1000 }
  ])
  expect(codexLiveSubagents([roster('working'), roster('completed')])).toEqual([])
  expect(codexLiveSubagents([{ ...roster('working'), agentId: 'child-2' }])).toEqual([])
})
