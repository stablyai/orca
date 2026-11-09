import { describe, expect, it } from 'vitest'
import { BuildLogBuffer } from './build-log-model'
import { LogReplayRouter } from './log-replay'

function visible(): { buffer: BuildLogBuffer; notifications: () => number } {
  let count = 0
  const buffer = new BuildLogBuffer((flush) => flush())
  buffer.subscribe(() => {
    count += 1
  })
  return { buffer, notifications: () => count }
}

describe('LogReplayRouter', () => {
  it('replays a reconnect into a shadow buffer and swaps it in once caught up', () => {
    const { buffer } = visible()
    const router = new LogReplayRouter(buffer)
    router.append('stdout', 'one\ntwo\nthree\n')
    expect(buffer.lines).toHaveLength(3)

    router.beginReplay()
    router.append('stdout', 'one\n')
    // Mid-replay the reader still sees the full log, never an emptied one.
    expect(buffer.lines.map((line) => line.plain)).toEqual(['one', 'two', 'three'])
    expect(router.replaying).toBe(true)

    router.append('stdout', 'two\nthree\nfour\n')
    expect(router.replaying).toBe(false)
    expect(buffer.lines.map((line) => line.plain)).toEqual(['one', 'two', 'three', 'four'])
    router.append('stdout', 'five\n')
    expect(buffer.lines).toHaveLength(5)
  })

  it('treats a reset event as a replay instead of clearing the visible log', () => {
    const { buffer } = visible()
    const router = new LogReplayRouter(buffer)
    router.append('stdout', 'a\nb\n')
    router.reset()
    expect(buffer.lines).toHaveLength(2)
    router.append('stdout', 'a\nb\n')
    expect(router.replaying).toBe(false)
  })

  it('reports growth only past the high-water mark', () => {
    const { buffer } = visible()
    const router = new LogReplayRouter(buffer)
    expect(router.append('stdout', 'a\nb\n')).toBe(true)
    router.beginReplay()
    // Replaying lines the reader already saw is not progress (no failure-counter reset).
    expect(router.append('stdout', 'a\n')).toBe(false)
    expect(router.append('stdout', 'b\n')).toBe(false)
    expect(router.append('stdout', 'c\n')).toBe(true)
  })

  it('swaps in a shorter replay when the stream ends', () => {
    const { buffer } = visible()
    const router = new LogReplayRouter(buffer)
    router.append('stdout', 'a\nb\nc\n')
    router.beginReplay()
    router.append('stdout', 'a\n')
    router.close()
    expect(buffer.lines.map((line) => line.plain)).toEqual(['a'])
  })

  it('keeps the visible log when a replay is abandoned', () => {
    const { buffer } = visible()
    const router = new LogReplayRouter(buffer)
    router.append('stdout', 'a\nb\n')
    router.beginReplay()
    router.append('stdout', 'a\n')
    router.abandon()
    expect(buffer.lines).toHaveLength(2)
    expect(router.replaying).toBe(false)
  })

  it('writes straight through when there is nothing to protect', () => {
    const { buffer } = visible()
    const router = new LogReplayRouter(buffer)
    router.beginReplay()
    expect(router.replaying).toBe(false)
    router.append('stdout', 'x\n')
    expect(buffer.lines).toHaveLength(1)
  })
})
