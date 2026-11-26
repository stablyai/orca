import { expect, it } from 'vitest'
import type { NativeChatBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { buildNativeChatToolRunRows } from './native-chat-tool-run-rows'

const call = (callId: string, command: string): NativeChatBlock => ({
  type: 'tool-call',
  name: 'shell',
  callId,
  input: { command },
  state: 'completed'
})

/** Each call's disclosure key, by the call. */
function keys(blocks: NativeChatBlock[]): Map<NativeChatBlock, string> {
  return new Map(
    buildNativeChatToolRunRows({ blocks, headerBlocks: blocks }).flatMap(
      (row): [NativeChatBlock, string][] =>
        row.kind === 'line' ? [[row.block, row.disclosureKey]] : []
    )
  )
}

it('keeps every drawn call’s disclosure key when a repeated provider id arrives live or by an older page', () => {
  // A provider that reused one id for different commands, as some do.
  const first = call('dup', 'echo one')
  const second = call('dup', 'echo two')
  const drawn = keys([first, second])
  expect(new Set(drawn.values()).size).toBe(2)

  for (const blocks of [
    // A live append that reuses the id, with other input and with the very same input.
    [first, second, call('dup', 'echo three')],
    [first, second, call('dup', 'echo two')],
    // An older page that brings an earlier call under the same id.
    [call('dup', 'echo zero'), first, second]
  ]) {
    const next = keys(blocks)
    // The calls already drawn keep their keys, so what was open stays open...
    expect(next.get(first)).toBe(drawn.get(first))
    expect(next.get(second)).toBe(drawn.get(second))
    // ...and the new call has a key of its own, so it starts closed.
    expect(new Set(next.values()).size).toBe(3)
  }
})
