import { describe, expect, it } from 'vitest'

import '../../../../../../../shared/clipboard/clipboard-text'
import { createRemoteRuntimePtyTextBatcher } from './remote-runtime-pty-batching'

describe('createRemoteRuntimePtyTextBatcher', () => {
  it('splits one large UTF-8 input without splitting a code point', () => {
    const flushes: string[] = []
    const batcher = createRemoteRuntimePtyTextBatcher(10, (text) => flushes.push(text), {
      maxPendingBytes: 4
    })

    expect(batcher.push('ab😀cd')).toBe(true)

    expect(flushes).toEqual(['ab', '😀'])
    batcher.flush()
    expect(flushes).toEqual(['ab', '😀', 'cd'])
  })
})
