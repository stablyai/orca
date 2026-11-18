import { describe, expect, it } from 'vitest'
import { withRemoteRangeReadSlot } from './runtime-remote-range-read-slots'

function heldRead() {
  const started: string[] = []
  const finish: (() => void)[] = []
  const read = (name: string) => () => {
    started.push(name)
    return new Promise<string>((resolve) => finish.push(() => resolve(name)))
  }
  return { started, finish, read }
}

describe('remote range read slots', () => {
  it('lets two reads per host run and starts the next as one finishes', async () => {
    const host = heldRead()
    const results = ['a', 'b', 'c', 'd'].map((name) =>
      withRemoteRangeReadSlot('env-shared', host.read(name))
    )
    await Promise.resolve()
    expect(host.started).toEqual(['a', 'b'])

    host.finish[0]!()
    await results[0]
    await Promise.resolve()
    expect(host.started).toEqual(['a', 'b', 'c'])

    host.finish.slice(1).forEach((finish) => finish())
    await results[2]
    await Promise.resolve()
    host.finish.at(-1)!()
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('does not hold one host behind another host’s reads', async () => {
    const busy = heldRead()
    const other = heldRead()
    void withRemoteRangeReadSlot('env-busy', busy.read('1'))
    void withRemoteRangeReadSlot('env-busy', busy.read('2'))
    const result = withRemoteRangeReadSlot('env-other', other.read('x'))
    await Promise.resolve()
    expect(other.started).toEqual(['x'])
    other.finish[0]!()
    expect(await result).toBe('x')
    busy.finish.forEach((finish) => finish())
  })
})
