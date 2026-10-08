import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { nativeChatSubagentDelegation } from './native-chat-subagent-delegation'

function message(blocks: NativeChatMessage['blocks']): NativeChatMessage {
  return { id: 'row', role: 'assistant', blocks, timestamp: 1, source: 'transcript' }
}

function collabFrame(head: string, truncated = false): NativeChatMessage {
  return message([
    {
      type: 'text',
      text: 'codex · item:collabAgentToolCall',
      providerFrame: {
        provider: 'codex',
        kind: 'item:collabAgentToolCall',
        payload: { head, byteLength: head.length, digest: 'digest', truncated }
      }
    }
  ])
}

const agentCall = { type: 'tool-call' as const, name: 'Agent', input: {} }
const readCall = { type: 'tool-call' as const, name: 'Read', input: {} }

describe('which rows delegate to subagents', () => {
  it('reads a roster in the order it added its agents', () => {
    const roster = message([
      { type: 'text', text: 'Kicked off 2 subagents' },
      {
        type: 'subagent-group',
        groupId: 'turn-1',
        agents: [
          { id: 'task-a', label: 'a', state: 'working' },
          { id: 'task-b', label: 'b', state: 'working' }
        ]
      }
    ])
    expect(nativeChatSubagentDelegation(roster)).toEqual({
      kind: 'roster',
      agentIds: ['task-a', 'task-b']
    })
  })

  it('names the first agent a Codex collab call acts on, and none it cannot read', () => {
    const wait = JSON.stringify({ tool: 'wait', receiverThreadIds: ['thread-a', 'thread-b'] })
    expect(nativeChatSubagentDelegation(collabFrame(wait))).toEqual({
      kind: 'call',
      agentId: 'thread-a'
    })
    expect(nativeChatSubagentDelegation(collabFrame('{"receiverThreadIds":[]}'))).toBeNull()
    expect(nativeChatSubagentDelegation(collabFrame(wait, true))).toBeNull()
    expect(nativeChatSubagentDelegation(collabFrame('{"receiverThreadIds":["a"'))).toBeNull()
  })

  it('counts a row whose newest part is a Claude spawn call as a spawn', () => {
    const result = { type: 'tool-result' as const, output: 'launched' }
    expect(nativeChatSubagentDelegation(message([agentCall, result]))).toEqual({ kind: 'spawn' })
    expect(
      nativeChatSubagentDelegation(message([{ type: 'text', text: 'Next.' }, readCall, agentCall]))
    ).toEqual({ kind: 'spawn' })
    expect(nativeChatSubagentDelegation(message([agentCall, readCall]))).toBeNull()
    expect(nativeChatSubagentDelegation(message([{ type: 'text', text: 'Done.' }]))).toBeNull()
  })
})
