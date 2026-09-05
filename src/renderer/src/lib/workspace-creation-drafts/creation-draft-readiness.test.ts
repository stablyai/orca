import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isCreationDraftInputReady } from './creation-draft-readiness'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
const ready = {
  handle: 'term-1',
  condition: 'tui-idle',
  satisfied: true,
  status: 'running',
  exitCode: null
}

describe('creation draft input readiness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    rpc.mockReset().mockResolvedValue({ wait: { ...ready } })
  })
  afterEach(() => vi.useRealTimers())

  it('uses retained host readiness and releases its deadline after positive evidence', async () => {
    expect(await isCreationDraftInputReady('term-1')).toBe(true)
    expect(rpc).toHaveBeenCalledExactlyOnceWith({ kind: 'local' }, 'terminal.wait', {
      terminal: 'term-1',
      for: 'tui-idle',
      timeoutMs: 100
    })
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([
    'codex-update-prompt',
    'codex-trust-workspace',
    'codex-model-migration-prompt',
    'codex-hooks-review-prompt',
    'agent-approval-prompt'
  ])('refuses %s even if an old idle signal is also present', async (blockedReason) => {
    rpc.mockResolvedValue({ wait: { ...ready, blockedReason } })
    expect(await isCreationDraftInputReady('term-1')).toBe(false)
  })
  it.each([
    { satisfied: false },
    { status: 'exited' },
    { status: 'unknown' },
    { handle: 'replacement' },
    { condition: 'exit' }
  ])('refuses contradictory evidence %j', async (change) => {
    rpc.mockResolvedValue({ wait: { ...ready, ...change } })
    expect(await isCreationDraftInputReady('term-1')).toBe(false)
  })
  it('does not treat a host timeout as readiness', async () => {
    rpc.mockRejectedValue(new Error('timeout'))
    expect(await isCreationDraftInputReady('term-1')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds an unresponsive transport and never turns late evidence into delivery', async () => {
    let respond!: (value: unknown) => void
    rpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve
        })
    )
    const pending = isCreationDraftInputReady('term-1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toBe(false)
    respond({ wait: ready })
    await Promise.resolve()
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
