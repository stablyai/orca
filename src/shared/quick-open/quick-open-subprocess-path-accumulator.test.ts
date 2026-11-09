import { describe, expect, it } from 'vitest'
import { QuickOpenSubprocessPathAccumulator } from './quick-open-subprocess-path-accumulator'

describe('Quick Open subprocess path accumulator', () => {
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
