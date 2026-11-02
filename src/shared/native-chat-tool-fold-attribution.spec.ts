import { expect, it } from 'vitest'
import { foldToolMessages, pairToolBlocks } from './native-chat-tool-fold'
import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'

function message(id: string, blocks: NativeChatBlock[]): NativeChatMessage {
  return { id, role: 'assistant', source: 'transcript', timestamp: 1, blocks }
}

it('shows an unrelated named result separately without consuming the call a later result answers', () => {
  const call: NativeChatBlock = { type: 'tool-call', name: 'Bash', callId: 'shell', input: {} }
  const stray: NativeChatBlock = { type: 'tool-result', callId: 'missing', output: 'unrelated' }
  const result: NativeChatBlock = { type: 'tool-result', callId: 'shell', output: 'owned' }
  const input = message('run', [call, stray, result])
  const [folded, orphan] = foldToolMessages([input])
  expect(folded?.blocks).toEqual([call, result])
  expect(pairToolBlocks(folded?.blocks ?? [])).toEqual([{ call, result }])
  expect(orphan).toMatchObject({ role: 'tool', blocks: [stray] })
  expect(orphan?.id).not.toBe(folded?.id)
  expect(input.blocks).toEqual([call, stray, result])
})

it('attributes repeated result object occurrences independently', () => {
  const result: NativeChatBlock = { type: 'tool-result', callId: 'shell', output: 'owned' }
  const call: NativeChatBlock = { type: 'tool-call', name: 'Bash', callId: 'shell', input: {} }
  const [folded, orphan] = foldToolMessages([message('run', [result, call, result, result])])
  expect(folded?.blocks).toEqual([call, result])
  expect(orphan?.blocks).toEqual([result, result])
})

it('keeps named and positional answers after calls fold across provider rows', () => {
  const silent: NativeChatBlock = { type: 'tool-call', name: 'spawn_agent', callId: 's', input: {} }
  const shell: NativeChatBlock = { type: 'tool-call', name: 'Bash', callId: 'x', input: {} }
  const done: NativeChatBlock = { type: 'tool-result', callId: 'x', output: 'shell output' }
  const positional: NativeChatBlock = { type: 'tool-result', output: 'spawn output' }
  const stray: NativeChatBlock = { type: 'tool-result', callId: 'missing', output: 'unrelated' }
  const [folded, orphan] = foldToolMessages([
    message('calls', [silent, shell]),
    { ...message('outputs', [stray, done, positional]), role: 'tool' }
  ])
  expect(folded?.blocks).toEqual([silent, shell, done, positional])
  expect(pairToolBlocks(folded?.blocks ?? [])).toEqual([
    { call: silent, result: positional },
    { call: shell, result: done }
  ])
  expect(orphan).toMatchObject({ id: 'outputs', role: 'tool', blocks: [stray] })
})

it('reuses a message with fully attributable answers', () => {
  const input = message('run', [
    { type: 'tool-call', name: 'Bash', callId: 'x', input: {} },
    { type: 'tool-result', callId: 'x', output: 'owned' }
  ])
  expect(foldToolMessages([input])[0]).toBe(input)
})
