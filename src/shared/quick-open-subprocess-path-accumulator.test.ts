import { describe, expect, it, vi } from 'vitest'
import { QuickOpenSubprocessPathAccumulator } from './quick-open-subprocess-path-accumulator'

describe('Quick Open subprocess path accumulator', () => {
  it('bounds one fragmented subprocess path and recovers after overflow', () => {
    const onPath = vi.fn(() => true)
    const fields = new QuickOpenSubprocessPathAccumulator(0, 3)

    expect(fields.push(Buffer.from('ab'), onPath)).toBe('continue')
    expect(fields.push(Buffer.from('cd'), onPath)).toBe('path-too-large')
    expect(fields.push(Buffer.from('ok\0'), onPath)).toBe('continue')
    expect(onPath).toHaveBeenCalledTimes(1)
    expect(onPath).toHaveBeenCalledWith('ok')
  })

  it('stops within a multi-path chunk without visiting later fields', () => {
    const visited: string[] = []
    const fields = new QuickOpenSubprocessPathAccumulator(0, 16)

    expect(
      fields.push(Buffer.from('one\0two\0three\0'), (path) => {
        visited.push(path)
        return path !== 'two'
      })
    ).toBe('stopped')
    expect(visited).toEqual(['one', 'two'])
  })
})
