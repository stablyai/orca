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
