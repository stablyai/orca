import { describe, expect, it } from 'vitest'
import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatToolCallBlock
} from '../../../../shared/native-chat-types'
import {
  buildNativeChatTaskListRows,
  nativeChatTaskListPredecessors
} from './native-chat-task-list-history'

function call(name = 'TodoWrite', status = 'pending'): NativeChatToolCallBlock {
  return {
    type: 'tool-call',
    name,
    input:
      name === 'TodoWrite'
        ? { todos: [{ content: 'Test', status }] }
        : { plan: [{ step: 'Test', status }] }
  }
}
function message(
  id: string,
  blocks: NativeChatBlock[],
  role: NativeChatMessage['role'] = 'assistant'
): NativeChatMessage {
  return { id, blocks, role, timestamp: 1, source: 'transcript' }
}

describe('native chat task list history', () => {
  it('carries predecessors across prose, ordinary tools, and user turns', () => {
    const first = call()
    const next = call('TodoWrite', 'completed')
    const history = nativeChatTaskListPredecessors([
      message('a', [first]),
      message('b', [{ type: 'text', text: 'Continue' }], 'user'),
      message('c', [{ type: 'tool-call', name: 'Read', input: {} }]),
      message('d', [next])
    ])
    expect(history.get('d')?.todowrite).toBe(first)
    expect(
      buildNativeChatTaskListRows([next], history.get('d')).rows.get(next)?.previous?.tasks[0]
        .status
    ).toBe('pending')
  })

  it('keeps interleaved tool families separate and ignores MCP lookalikes', () => {
    const claude = call()
    const codex = call('update_plan')
    const next = call('TodoWrite', 'completed')
    const model = buildNativeChatTaskListRows([claude, codex, call('mcp__x__TodoWrite'), next])
    expect(model.rows.get(codex)?.previous).toBeUndefined()
    expect(model.rows.get(next)?.previous).toEqual(model.rows.get(claude)?.list)
    const history = nativeChatTaskListPredecessors([
      message('a', [claude]),
      message('b', [codex]),
      message('c', [next])
    ])
    expect(history.get('c')).toEqual({ todowrite: claude, update_plan: codex })
  })

  it('skips failed and malformed calls and keeps errors unconsumed', () => {
    const first = call()
    const failed = { ...call(), state: 'failed' as const }
    const rejected = call('TodoWrite', 'completed')
    const error: NativeChatBlock = { type: 'tool-result', output: 'Rejected', isError: true }
    const next = call('TodoWrite', 'in_progress')
    const blocks: NativeChatBlock[] = [
      first,
      { type: 'tool-result', output: 'ok' },
      failed,
      { type: 'tool-result', output: 'failed' },
      rejected,
      error,
      { ...call(), input: '{' },
      next
    ]
    const model = buildNativeChatTaskListRows(blocks)
    expect(model.rows.has(failed)).toBe(false)
    expect(model.rows.has(rejected)).toBe(false)
    expect(model.consumedResults.has(error)).toBe(false)
    expect(model.rows.get(next)?.previous).toEqual(model.rows.get(first)?.list)
    const history = nativeChatTaskListPredecessors([
      message('a', blocks.slice(0, -1)),
      message('b', [next])
    ])
    expect(history.get('b')?.todowrite).toBe(first)
  })

  it('updates predecessor identity after pagination and remains stable on rerender', () => {
    const first = call()
    const second = call('TodoWrite', 'in_progress')
    const tail = message('b', [second])
    expect(nativeChatTaskListPredecessors([tail]).get('b')?.todowrite).toBeUndefined()
    const history = nativeChatTaskListPredecessors([message('a', [first]), tail])
    expect(history.get('b')?.todowrite).toBe(first)
    expect(nativeChatTaskListPredecessors([message('a', [first]), tail]).get('b')?.todowrite).toBe(
      history.get('b')?.todowrite
    )
    expect(nativeChatTaskListPredecessors([tail]).get('b')?.todowrite).toBeUndefined()
  })

  it('diffs a running call before its result arrives and consumes a successful result', () => {
    const first = call()
    const running = { ...call('TodoWrite', 'in_progress'), state: 'running' as const }
    const result: NativeChatBlock = { type: 'tool-result', output: 'ok' }
    const model = buildNativeChatTaskListRows([running, result], {
      todowrite: first,
      update_plan: undefined
    })
    expect(model.rows.get(running)?.previous).toBeDefined()
    expect(model.consumedResults.has(result)).toBe(true)
  })
})
