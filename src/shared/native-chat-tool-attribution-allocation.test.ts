import { describe, expect, it } from 'vitest'
import { foldToolMessages } from './native-chat-tool-fold'
import { pairToolBlocks } from './native-chat-tool-pairs'
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
  it('allocates pair wrappers only for the consumer, including a large pending backlog and orphans', () => {
    const calls: NativeChatBlock[] = Array.from({ length: 2048 }, (_, i) => ({
      type: 'tool-call',
      name: 'read',
      callId: `call-${i}`,
      input: { path: `file-${i}` }
    }))
    const answer: NativeChatBlock = {
      type: 'tool-result',
      callId: 'call-2047',
      output: 'last call answered'
    }
    const orphan: NativeChatBlock = {
      type: 'tool-result',
      callId: 'unknown',
      output: 'unattributed evidence'
    }
    const input = message('backlog', [...calls, answer, orphan])
    const blocks = new Set<unknown>(input.blocks)
    const push = Array.prototype.push
    let wrappers = 0
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      for (const item of items) {
        if (
          typeof item === 'object' &&
          item !== null &&
          (('call' in item && blocks.has(item.call)) ||
            ('result' in item && blocks.has(item.result)))
        ) {
          wrappers += 1
        }
      }
      return push.apply(this, items)
    }
    let folded: NativeChatMessage[]
    let pairs: ReturnType<typeof pairToolBlocks>[]
    let foldWrappers = 0
    try {
      folded = foldToolMessages([input])
      foldWrappers = wrappers
      pairs = folded.map((entry) => pairToolBlocks(entry.blocks))
    } finally {
      Array.prototype.push = push
    }
    expect(foldWrappers).toBe(0)
    expect(wrappers).toBe(calls.length + 1)
    expect(pairs[0]?.at(-1)).toEqual({ call: calls.at(-1), result: answer })
    expect(pairs[1]).toEqual([{ result: orphan }])
    expect(folded[1]).toMatchObject({ role: 'tool', unpairedToolResults: true })
    expect(input.blocks).toEqual([...calls, answer, orphan])
  })

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
