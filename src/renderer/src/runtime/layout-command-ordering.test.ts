import { describe, expect, it, vi } from 'vitest'
import { afterWorkspaceLayoutCommands } from './layout-apply-call'

describe('ordinary content command ordering', () => {
  it('defers a close until its earlier creation has settled, without blocking another workspace', async () => {
    let finishCreate!: () => void
    const order: string[] = []
    const creation = afterWorkspaceLayoutCommands(
      { kind: 'local' },
      'ordered-create-close',
      () =>
        new Promise<void>((resolve) => {
          order.push('create-dispatched')
          finishCreate = resolve
        })
    )
    const close = afterWorkspaceLayoutCommands(
      { kind: 'local' },
      'ordered-create-close',
      async () => {
        order.push('close-dispatched')
      }
    )
    await afterWorkspaceLayoutCommands({ kind: 'local' }, 'independent-workspace', async () => {
      order.push('other-dispatched')
    })
    expect(order).toEqual(['create-dispatched', 'other-dispatched'])
    finishCreate()
    await Promise.all([creation, close])
    expect(order).toEqual(['create-dispatched', 'other-dispatched', 'close-dispatched'])
  })

  it('releases a rejected creation and later reuses the workspace after settlement', async () => {
    let rejectCreate!: (error: Error) => void
    const creation = afterWorkspaceLayoutCommands(
      { kind: 'local' },
      'refused-create-close',
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCreate = reject
        })
    )
    const close = vi.fn(async () => 'closed')
    const closing = afterWorkspaceLayoutCommands({ kind: 'local' }, 'refused-create-close', close)
    const rejected = expect(creation).rejects.toThrow('refused')
    rejectCreate(new Error('refused'))
    await rejected
    expect(await closing).toBe('closed')
    expect(close).toHaveBeenCalledOnce()
    expect(
      await afterWorkspaceLayoutCommands(
        { kind: 'local' },
        'refused-create-close',
        async () => 'reused'
      )
    ).toBe('reused')
  })
})
