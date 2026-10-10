import { describe, expect, it } from 'vitest'
import { KeyedSerialRunner } from './keyed-serial-runner'

describe('KeyedSerialRunner', () => {
  it('runs tasks for one key in order, even after a failure, and never blocks other keys', async () => {
    const runner = new KeyedSerialRunner()
    const order: string[] = []
    let releaseFirst!: () => void
    const first = runner.run('repo-a', async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      order.push('a1')
      throw new Error('a1 failed')
    })
    const second = runner.run('repo-a', async () => {
      order.push('a2')
      return 'a2'
    })
    const other = runner.run('repo-b', async () => {
      order.push('b1')
      return 'b1'
    })

    await expect(other).resolves.toBe('b1')
    expect(order).toEqual(['b1'])
    releaseFirst()
    await expect(first).rejects.toThrow('a1 failed')
    await expect(second).resolves.toBe('a2')
    expect(order).toEqual(['b1', 'a1', 'a2'])
  })
})
