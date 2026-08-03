import { describe, expect, it } from 'vitest'
import { reconcileNativeChatRowIdentity } from './native-chat-row-identity'
import type { NativeChatBlock, NativeChatMessage } from '../../../../shared/native-chat-types'

const text = (value: string): NativeChatBlock => ({ type: 'text', text: value })

const message = (
  id: string,
  blocks: NativeChatBlock[],
  role: NativeChatMessage['role'] = 'assistant'
): NativeChatMessage => ({ id, role, blocks, timestamp: 0, source: 'transcript' })

describe('reconcileNativeChatRowIdentity', () => {
  it('returns next as-is on the first frame', () => {
    const next = [message('a', [text('hi')])]
    expect(reconcileNativeChatRowIdentity(next, null)).toBe(next)
  })

  it('returns the previous array when nothing changed', () => {
    const blocks = [text('hi')]
    const previous = [message('a', blocks)]
    // A fresh projection: new message objects and a new array, same content.
    const next = [message('a', [...blocks])]
    expect(reconcileNativeChatRowIdentity(next, previous)).toBe(previous)
  })

  it('reuses unchanged row objects when a later row changes', () => {
    const stableBlocks = [text('settled')]
    const previous = [message('a', stableBlocks), message('b', [text('old')])]
    const next = [message('a', [...stableBlocks]), message('b', [text('new')])]

    const result = reconcileNativeChatRowIdentity(next, previous)
    // This is the property MessageRow's memo depends on.
    expect(result[0]).toBe(previous[0])
    expect(result[1]).toBe(next[1])
  })

  it('treats an appended block as a change', () => {
    const previous = [message('a', [text('one')])]
    const appended = [text('one'), text('two')]
    const next = [message('a', appended)]
    expect(reconcileNativeChatRowIdentity(next, previous)[0]).toBe(next[0])
  })

  it('treats a replaced block object as a change even at equal length', () => {
    // foldToolMessages clones the blocks array; a genuinely new block object
    // must still invalidate.
    const previous = [message('a', [text('one')])]
    const next = [message('a', [text('changed')])]
    expect(reconcileNativeChatRowIdentity(next, previous)[0]).toBe(next[0])
  })

  it('treats a role change as a change', () => {
    const blocks = [text('hi')]
    const previous = [message('a', blocks, 'assistant')]
    const next = [message('a', blocks, 'user')]
    expect(reconcileNativeChatRowIdentity(next, previous)[0]).toBe(next[0])
  })

  it('reuses the stable prefix when a row is appended', () => {
    const blocks = [text('hi')]
    const previous = [message('a', blocks)]
    const next = [message('a', [...blocks]), message('b', [text('new')])]

    const result = reconcileNativeChatRowIdentity(next, previous)
    expect(result).toHaveLength(2)
    expect(result[0]).toBe(previous[0])
  })

  it('does not reuse across a differing id at the same index', () => {
    const blocks = [text('hi')]
    const previous = [message('a', blocks)]
    const next = [message('z', [...blocks])]
    expect(reconcileNativeChatRowIdentity(next, previous)[0]).toBe(next[0])
  })
})
