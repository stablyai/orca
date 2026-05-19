import { describe, expect, it, vi } from 'vitest'
import { isBackgroundRuntimeMethod, RuntimeRpcCallQueuePool } from './runtime-rpc-call-queue'

describe('runtime RPC call queue', () => {
  it('classifies per-worktree decoration lookups as background work', () => {
    expect(isBackgroundRuntimeMethod('github.prForBranch')).toBe(true)
    expect(isBackgroundRuntimeMethod('hostedReview.forBranch')).toBe(true)
    expect(isBackgroundRuntimeMethod('terminal.send')).toBe(false)
    expect(isBackgroundRuntimeMethod('worktree.create')).toBe(false)
  })

  it('limits background calls while allowing foreground runtime work through', async () => {
    const queue = new RuntimeRpcCallQueuePool(2, 1)
    const started: string[] = []
    const pending: ((value: string) => void)[] = []
    const enqueuePending = (method: string, label: string): Promise<string> =>
      queue.enqueue('web-runtime', method, async () => {
        started.push(label)
        return await new Promise<string>((resolve) => pending.push(resolve))
      })

    const background1 = enqueuePending('github.prForBranch', 'background-1')
    const background2 = enqueuePending('hostedReview.forBranch', 'background-2')
    await vi.waitFor(() => expect(started).toEqual(['background-1']))

    const foreground = queue.enqueue('web-runtime', 'terminal.send', async () => {
      started.push('foreground')
      return 'foreground'
    })
    await expect(foreground).resolves.toBe('foreground')
    expect(started).toEqual(['background-1', 'foreground'])

    pending.shift()?.('background-1')
    await expect(background1).resolves.toBe('background-1')
    await vi.waitFor(() => expect(started).toEqual(['background-1', 'foreground', 'background-2']))

    pending.shift()?.('background-2')
    await expect(background2).resolves.toBe('background-2')
  })
})
