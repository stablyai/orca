import { afterEach, describe, expect, it, vi } from 'vitest'
import { callAbortableLocalRuntime } from './abortable-runtime-environment-call'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function stubLocalSubscription() {
  const unsubscribe = vi.fn()
  let respond!: (response: { ok: true; result: unknown }) => void
  const subscribe = vi.fn(
    async (_request: unknown, callback: (response: { ok: true; result: unknown }) => void) => {
      respond = callback
      return { unsubscribe }
    }
  )
  vi.stubGlobal('window', { api: { runtime: { subscribe } } })
  return {
    respond: (response: { ok: true; result: unknown }) => respond(response),
    subscribe,
    unsubscribe
  }
}

describe('abortable local runtime call', () => {
  it('unsubscribes the host request after a response', async () => {
    const runtime = stubLocalSubscription()
    const request = callAbortableLocalRuntime(
      'terminal.list',
      { worktree: 'id:worktree-1' },
      100,
      new AbortController().signal
    )
    await Promise.resolve()

    runtime.respond({ ok: true, result: { terminals: [] } })

    await expect(request).resolves.toEqual({ ok: true, result: { terminals: [] } })
    expect(runtime.unsubscribe).toHaveBeenCalledOnce()
  })

  it('aborts and unsubscribes a request whose inventory never responds', async () => {
    const runtime = stubLocalSubscription()
    const controller = new AbortController()
    const request = callAbortableLocalRuntime('terminal.list', {}, 100, controller.signal)
    await Promise.resolve()

    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(runtime.unsubscribe).toHaveBeenCalledOnce()
  })

  it('enforces a response deadline and unsubscribes the host request', async () => {
    vi.useFakeTimers()
    const runtime = stubLocalSubscription()
    const request = callAbortableLocalRuntime(
      'terminal.list',
      {},
      100,
      new AbortController().signal
    )
    const settled = request.catch((error: unknown) => error)
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(100)

    await expect(settled).resolves.toMatchObject({
      message: 'Runtime request timed out before terminal.list completed'
    })
    expect(runtime.unsubscribe).toHaveBeenCalledOnce()
  })
})
