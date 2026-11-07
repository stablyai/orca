import { describe, expect, it } from 'vitest'
import { PtyShutdownOutputQueue } from './pty-shutdown-output-queue'

const BYTE_LIMIT = 524_288

describe('PTY shutdown output queue', () => {
  it('keeps exact UTF-8 boundaries, Unicode tails, and metadata identity', () => {
    const boundaryQueue = new PtyShutdownOutputQueue()
    const emptyMeta = { rawLength: 9, transformed: true, droppedOutput: true }
    boundaryQueue.enqueue({ kind: 'replay', data: 'a'.repeat(BYTE_LIMIT) })
    boundaryQueue.enqueue({ kind: 'data', data: '', meta: emptyMeta })
    boundaryQueue.enqueue({ kind: 'replay', data: 'b' })

    const boundary = boundaryQueue.takeAll()
    expect(boundary).toEqual([
      { kind: 'data', data: '', meta: emptyMeta },
      { kind: 'replay', data: 'b' }
    ])
    expect(boundary[0]?.kind === 'data' ? boundary[0].meta : undefined).toBe(emptyMeta)

    const unicodeQueue = new PtyShutdownOutputQueue()
    const emojiTail = '😀'.repeat(BYTE_LIMIT / 4)
    const unicodeMeta = { seq: 7, rawLength: emojiTail.length + 1, background: true }
    unicodeQueue.enqueue({ kind: 'data', data: `P${emojiTail}`, meta: unicodeMeta })
    const [unicode] = unicodeQueue.takeAll()
    expect(unicode?.data).toBe(emojiTail)
    expect(unicode?.kind === 'data' ? unicode.meta : undefined).toBe(unicodeMeta)

    const loneSurrogateQueue = new PtyShutdownOutputQueue()
    const loneSurrogateTail = `\ud800${'z'.repeat(BYTE_LIMIT - 3)}`
    loneSurrogateQueue.enqueue({ kind: 'replay', data: `P${loneSurrogateTail}` })
    expect(loneSurrogateQueue.takeAll()[0]?.data).toBe(loneSurrogateTail)
  })

  it('evicts whole oldest events without merging replay and live boundaries', () => {
    const queue = new PtyShutdownOutputQueue()
    const meta = { seq: 42, rawLength: BYTE_LIMIT - 3, transformed: true }
    queue.enqueue({ kind: 'replay', data: 'old' })
    queue.enqueue({ kind: 'data', data: 'x'.repeat(BYTE_LIMIT - 3), meta })
    queue.enqueue({ kind: 'replay', data: 'new' })

    const retained = queue.takeAll()
    expect(retained).toEqual([
      { kind: 'data', data: 'x'.repeat(BYTE_LIMIT - 3), meta },
      { kind: 'replay', data: 'new' }
    ])
    expect(retained[0]?.kind === 'data' ? retained[0].meta : undefined).toBe(meta)
  })

  it('retains zero-byte event boundaries without imposing a count cap', () => {
    const queue = new PtyShutdownOutputQueue()
    for (let index = 0; index < 4_097; index += 1) {
      queue.enqueue({ kind: 'data', data: '', meta: { seq: index, transformed: true } })
    }
    const retained = queue.takeAll()
    expect(retained).toHaveLength(4_097)
    expect(retained[0]).toEqual({ kind: 'data', data: '', meta: { seq: 0, transformed: true } })
    expect(retained.at(-1)).toEqual({
      kind: 'data',
      data: '',
      meta: { seq: 4_096, transformed: true }
    })
  })
})
