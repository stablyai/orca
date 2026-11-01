import { describe, expect, it } from 'vitest'
import type {
  NativeChatBlock,
  NativeChatMessage
} from '../../../../shared/native-chat/native-chat-types'
import { foldToolMessages } from '../../../../shared/native-chat/tools/native-chat-tool-fold'
import { nativeChatTaskListState } from './native-chat-task-list-state'

function message(id: string, blocks: NativeChatBlock[]): NativeChatMessage {
  return { id, role: 'assistant', timestamp: 1, source: 'transcript', blocks }
}
function call(content: string, status = 'pending'): NativeChatBlock {
  return { type: 'tool-call', name: 'TodoWrite', input: { todos: [{ content, status }] } }
}

describe('nativeChatTaskListState', () => {
  it('preserves latest state across user follow-ups and clears it on an explicit empty list', () => {
    const first = message('first', [call('Read')])
    const user = { ...message('user', [{ type: 'text', text: 'Continue' }]), role: 'user' as const }
    const empty = message('empty', [{ type: 'tool-call', name: 'TodoWrite', input: { todos: [] } }])
    expect(nativeChatTaskListState([first, user]).list?.tasks).toHaveLength(1)
    expect(nativeChatTaskListState([first, user, empty]).list?.tasks).toEqual([])
    expect(nativeChatTaskListState([]).list).toBeNull()
  })

  it('does not replace valid state with malformed or failed calls, and retains their diagnostics', () => {
    const first = message('first', [call('Read')])
    const malformed = message('malformed', [
      { type: 'tool-call', name: 'TodoWrite', input: '{' },
      { type: 'tool-result', output: 'Invalid arguments', isError: true }
    ])
    const failed = message('failed', [
      call('Wrong', 'completed'),
      { type: 'tool-result', output: 'Update rejected', isError: true }
    ])
    const failedCall = message('failed-call', [
      { type: 'tool-call', name: 'TodoWrite', state: 'failed', input: { todos: [] } }
    ])
    const result = nativeChatTaskListState([first, malformed, failed, failedCall])
    expect(result.list?.tasks[0].content).toBe('Read')
    expect(result.messages.slice(1)).toEqual([malformed, failed, failedCall])
  })

  it('preserves accepted tasks when named orphan failures remain visibly separate', () => {
    const tasks = { ...call('Accepted'), callId: 'accepted' }
    const rejected = { ...call('Rejected', 'completed'), callId: 'rejected' }
    const source = message('calls', [tasks, rejected])
    const outputs = {
      ...message('outputs', [
        { type: 'tool-result', callId: 'unknown', output: 'Unowned failure', isError: true },
        { type: 'tool-result', callId: 'rejected', output: 'Rejected update', isError: true },
        { type: 'tool-result', callId: 'accepted', output: 'Accepted update' }
      ]),
      role: 'tool' as const
    }
    const folded = foldToolMessages([source, outputs])
    expect(nativeChatTaskListState(folded).list?.tasks).toEqual([
      { content: 'Accepted', status: 'pending' }
    ])
    expect(folded[1]).toMatchObject({ id: 'outputs', role: 'tool', blocks: [outputs.blocks[0]] })
    expect(nativeChatTaskListState(foldToolMessages(folded)).list?.tasks).toEqual([
      { content: 'Accepted', status: 'pending' }
    ])
  })
})
