import { describe, expect, it } from 'vitest'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import {
  appendOmpRpcToolCallBlock,
  upsertOmpRpcToolResultBlock
} from './omp-rpc-tool-block-projection'

describe('appendOmpRpcToolCallBlock', () => {
  it('projects the canonical `args` payload into the block input', () => {
    const blocks = appendOmpRpcToolCallBlock([], {
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read',
      args: { path: 'a.ts' }
    })
    expect(blocks).toEqual([
      { type: 'tool-call', name: 'read', input: { path: 'a.ts' }, toolCallId: 'call-1' }
    ])
  })

  it('falls back to a generic name and omits an absent toolCallId', () => {
    const blocks = appendOmpRpcToolCallBlock([], { type: 'tool_execution_start' })
    expect(blocks).toEqual([{ type: 'tool-call', name: 'tool', input: undefined }])
  })
})

describe('upsertOmpRpcToolResultBlock', () => {
  const call: NativeChatBlock = {
    type: 'tool-call',
    name: 'bash',
    input: { command: 'ls' },
    toolCallId: 'call-1'
  }

  it('appends the first result for a call', () => {
    const blocks = upsertOmpRpcToolResultBlock([call], {
      toolCallId: 'call-1',
      output: 'one',
      isError: false
    })
    expect(blocks).toEqual([
      call,
      { type: 'tool-result', output: 'one', isError: false, toolCallId: 'call-1' }
    ])
  })

  // tool_execution_update streams the output produced so far; a running tool
  // must occupy ONE row that grows, never one row per partial frame.
  it('replaces a prior result for the same toolCallId in place', () => {
    const afterFirst = upsertOmpRpcToolResultBlock([call], {
      toolCallId: 'call-1',
      output: 'one',
      isError: false
    })
    const afterSecond = upsertOmpRpcToolResultBlock(afterFirst, {
      toolCallId: 'call-1',
      output: 'one\ntwo',
      isError: false
    })
    expect(afterSecond).toHaveLength(2)
    expect(afterSecond[1]).toEqual({
      type: 'tool-result',
      output: 'one\ntwo',
      isError: false,
      toolCallId: 'call-1'
    })
  })

  it('keeps results for different calls separate', () => {
    const other: NativeChatBlock = {
      type: 'tool-call',
      name: 'read',
      input: {},
      toolCallId: 'call-2'
    }
    const blocks = upsertOmpRpcToolResultBlock(
      upsertOmpRpcToolResultBlock([call, other], {
        toolCallId: 'call-1',
        output: 'a',
        isError: false
      }),
      { toolCallId: 'call-2', output: 'b', isError: false }
    )
    expect(blocks.filter((block) => block.type === 'tool-result')).toHaveLength(2)
  })

  // An id-less frame cannot be paired with anything, so replacing "the last
  // result" would silently overwrite an unrelated call's output.
  it('always appends when the frame carries no toolCallId', () => {
    const blocks = upsertOmpRpcToolResultBlock(
      upsertOmpRpcToolResultBlock([], { output: 'a', isError: false }),
      { output: 'b', isError: false }
    )
    expect(blocks).toEqual([
      { type: 'tool-result', output: 'a', isError: false },
      { type: 'tool-result', output: 'b', isError: false }
    ])
  })

  it('caps a large output rather than retaining it whole', () => {
    const blocks = upsertOmpRpcToolResultBlock([], {
      toolCallId: 'call-1',
      output: 'x'.repeat(200_000),
      isError: false
    })
    const result = blocks[0]
    expect(result?.type).toBe('tool-result')
    if (result?.type === 'tool-result') {
      expect(result.output.length).toBeLessThan(200_000)
      expect(result.output).toContain('truncated')
    }
  })

  it('marks an errored result', () => {
    const blocks = upsertOmpRpcToolResultBlock([], {
      toolCallId: 'call-1',
      output: 'boom',
      isError: true
    })
    expect(blocks[0]).toEqual({
      type: 'tool-result',
      output: 'boom',
      isError: true,
      toolCallId: 'call-1'
    })
  })
})
