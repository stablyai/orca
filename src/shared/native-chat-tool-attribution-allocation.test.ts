import { describe, expect, it } from 'vitest'
import { foldToolMessages } from './native-chat-tool-fold'
import type {
  NativeChatBackgroundTaskBlock,
  NativeChatBlock,
  NativeChatMessage
} from './native-chat-types'

function message(id: string, blocks: NativeChatBlock[]): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks,
    timestamp: null,
    source: 'transcript'
  }
}

function backgroundTaskMessage(id: string): NativeChatMessage {
  const task: NativeChatBackgroundTaskBlock = {
    type: 'background-task',
    taskId: 'task-1',
    kind: 'command',
    label: 'wait',
    state: 'working'
  }
  return {
    id,
    role: 'system',
    blocks: [{ type: 'text', text: 'Started background command "wait"' }, task],
    timestamp: null,
    source: 'transcript'
  }
}

describe('tool attribution allocation', () => {
  it('does not append valid prose blocks to discarded attribution arrays', () => {
    const prose: NativeChatBlock = { type: 'text', text: 'Ordinary prose' }
    const messages = Array.from({ length: 1000 }, (_, i) => message(String(i), [prose]))
    const push = Array.prototype.push
    let appends = 0
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      if (items[0] === prose) {
        appends += items.length
      }
      return push.apply(this, items)
    }
    let output: NativeChatMessage[]
    try {
      output = foldToolMessages(messages)
    } finally {
      Array.prototype.push = push
    }
    expect(appends).toBe(0)
    output.forEach((entry, i) => expect(entry).toBe(messages[i]))
  })

  it('removes only unattributable results while preserving subsequent call/result pairs', () => {
    const text: NativeChatBlock = { type: 'text', text: 'Prose' }
    const call: NativeChatBlock = {
      type: 'tool-call',
      name: 'read',
      input: {}
    }
    const result: NativeChatBlock = { type: 'tool-result', output: 'done' }
    const input = message('one', [text, result, text, call, result, result, text])
    expect(foldToolMessages([input])[0].blocks).toEqual([text, text, call, result, text])
    expect(input.blocks).toHaveLength(7)
    expect(foldToolMessages([message('two', [result])])).toEqual([])
  })

  it('keeps tool attribution across a background-task activity row', () => {
    const call: NativeChatBlock = {
      type: 'tool-call',
      name: 'read',
      input: {}
    }
    const result: NativeChatBlock = { type: 'tool-result', output: 'done' }
    const folded = foldToolMessages([
      message('assistant', [call]),
      backgroundTaskMessage('background-task'),
      message('result', [result])
    ])

    expect(folded).toHaveLength(2)
    expect(folded[0]?.blocks).toEqual([call, result])
    expect(folded[1]).toMatchObject({ id: 'background-task' })
  })
})
