import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalSetupObservers } from './terminal-setup-observers'
import type { TerminalSetupStatus } from '../../../../../shared/terminal/pty/lifecycle/terminal-setup-status'

const pending: TerminalSetupStatus = {
  runtimeId: 'runtime-a',
  ptyId: 'pty-a',
  dependencyId: 'attempt-a',
  state: 'pending'
}
const ready: TerminalSetupStatus = { ...pending, state: 'ready' }
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

afterEach(() => vi.useRealTimers())

describe('exact Setup observation', () => {
  it('catches completion during the first read and latches a pushed result before a late pending reply', async () => {
    vi.useFakeTimers()
    const owner = new TerminalSetupObservers()
    owner.setConnected('host', true)
    const late = Promise.withResolvers<TerminalSetupStatus>()
    const read = vi.fn().mockResolvedValueOnce(pending).mockReturnValueOnce(late.promise)
    const wait = owner.wait('host', 'terminal-a', read)
    await flush()
    owner.changed('host', ready)
    await expect(wait).resolves.toBeUndefined()
    late.resolve(pending)
    await flush()
    // No observer survives the terminal result; the next owner must obtain its own snapshot.
    const next = owner.wait('host', 'terminal-a', async () => ready)
    await expect(next).resolves.toBeUndefined()
  })

  it.each([
    { ...ready, dependencyId: null },
    { ...ready, runtimeId: 'runtime-b' },
    { ...ready, dependencyId: 'retry-b' },
    { ...pending, state: 'unknown' as const },
    { ...pending, state: 'failed' as const }
  ])('refuses observation loss or replacement on reconnect: %j', async (afterReconnect) => {
    vi.useFakeTimers()
    const owner = new TerminalSetupObservers()
    owner.setConnected('host', true)
    let status = pending
    const wait = owner.wait('host', 'terminal-a', async () => status)
    const refused = expect(wait).rejects.toThrow('Setup')
    await flush()
    owner.setConnected('host', false)
    status = afterReconnect
    owner.changed('host', ready)
    owner.setConnected('host', true)
    await refused
  })

  it('recovers missed completion and cancels one observer without cancelling its successor', async () => {
    vi.useFakeTimers()
    const owner = new TerminalSetupObservers()
    owner.setConnected('host', true)
    const abort = new AbortController()
    let status = pending
    const cancelled = owner.wait('host', 'terminal-a', async () => status, abort.signal)
    const refused = expect(cancelled).rejects.toBeDefined()
    const survivor = owner.wait('host', 'terminal-a', async () => status)
    await flush()
    abort.abort()
    await refused
    owner.setConnected('host', false)
    status = ready
    owner.setConnected('host', true)
    await expect(survivor).resolves.toBeUndefined()
    expect(owner.pendingScopes()).toEqual([])
  })

  it('uses shipped readiness only for a proven old host, and refuses a failed status read', async () => {
    const owner = new TerminalSetupObservers()
    owner.setConnected('host', true)
    await expect(owner.wait('host', 'old', async () => null)).resolves.toBeUndefined()
    await expect(
      owner.wait('host', 'lost', async () => {
        throw new Error('connection lost')
      })
    ).rejects.toThrow('connection lost')
  })
})
