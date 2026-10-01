import { describe, expect, it } from 'vitest'
import { runWithGitOperationLock } from './git-operation-lock'

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
  }
}

describe('runWithGitOperationLock', () => {
  it('runs ordinary callers one at a time in arrival order', async () => {
    const order: string[] = []
    const holder = gate()
    const first = runWithGitOperationLock('k1', undefined, async () => {
      order.push('first')
      await holder.promise
    })
    const second = runWithGitOperationLock('k1', undefined, async () => {
      order.push('second')
    })
    const third = runWithGitOperationLock('k1', undefined, async () => {
      order.push('third')
    })
    await flush()
    expect(order).toEqual(['first'])
    holder.open()
    await Promise.all([first, second, third])
    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('lets a priority caller pass queued ordinary callers but not the running one', async () => {
    const order: string[] = []
    const holder = gate()
    const running = runWithGitOperationLock('k2', undefined, async () => {
      order.push('running background')
      await holder.promise
    })
    const queued = runWithGitOperationLock('k2', undefined, async () => {
      order.push('queued background')
    })
    const create = runWithGitOperationLock(
      'k2',
      undefined,
      async () => {
        order.push('create')
      },
      { priority: true }
    )
    await flush()
    expect(order).toEqual(['running background'])
    holder.open()
    await Promise.all([running, queued, create])
    expect(order).toEqual(['running background', 'create', 'queued background'])
  })

  it('keeps priority callers in arrival order among themselves', async () => {
    const order: string[] = []
    const holder = gate()
    const running = runWithGitOperationLock('k3', undefined, () => holder.promise)
    const calls = ['a', 'b'].map((name) =>
      runWithGitOperationLock(
        'k3',
        undefined,
        async () => {
          order.push(name)
        },
        { priority: true }
      )
    )
    holder.open()
    await Promise.all([running, ...calls])
    expect(order).toEqual(['a', 'b'])
  })

  it('drops an aborted waiter without disturbing the queue', async () => {
    const order: string[] = []
    const holder = gate()
    const controller = new AbortController()
    const running = runWithGitOperationLock('k4', undefined, () => holder.promise)
    const aborted = runWithGitOperationLock('k4', controller.signal, async () => {
      order.push('aborted')
    })
    const next = runWithGitOperationLock('k4', undefined, async () => {
      order.push('next')
    })
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    holder.open()
    await Promise.all([running, next])
    expect(order).toEqual(['next'])
  })

  it('releases the key after a failing holder', async () => {
    await expect(
      runWithGitOperationLock('k5', undefined, async () => {
        throw new Error('fetch failed')
      })
    ).rejects.toThrow('fetch failed')
    await expect(runWithGitOperationLock('k5', undefined, async () => 'ok')).resolves.toBe('ok')
  })
})
