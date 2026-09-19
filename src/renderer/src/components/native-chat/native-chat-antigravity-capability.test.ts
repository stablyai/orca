import { describe, expect, it, vi } from 'vitest'
import { guardAntigravityChatTransport } from './native-chat-antigravity-capability'
import {
  RUNTIME_NATIVE_CHAT_READ_ERROR,
  RUNTIME_NATIVE_CHAT_TOO_OLD
} from './native-chat-runtime-contract'

const args = {
  agent: 'antigravity' as const,
  sessionId: 'conversation',
  subscriptionId: 'subscription'
}

function setup(supports: () => Promise<boolean>) {
  const stop = vi.fn()
  const transport = {
    readSession: vi.fn(async () => ({ messages: [] })),
    subscribe: vi.fn(() => stop)
  }
  return { transport, stop, guarded: guardAntigravityChatTransport(transport, supports) }
}

describe('Antigravity chat host capability', () => {
  it('rejects old hosts before read or subscribe without claiming the transcript is pending', async () => {
    const { guarded, transport } = setup(async () => false)
    expect(await guarded.readSession('antigravity', 'conversation')).toEqual({
      error: RUNTIME_NATIVE_CHAT_TOO_OLD
    })
    const onFrame = vi.fn()
    const close = await guarded.subscribe(args, onFrame)
    await vi.waitFor(() =>
      expect(onFrame).toHaveBeenCalledWith({
        type: 'snapshot',
        messages: [],
        hasMore: false,
        error: RUNTIME_NATIVE_CHAT_TOO_OLD
      })
    )
    expect(transport.readSession).not.toHaveBeenCalled()
    expect(transport.subscribe).not.toHaveBeenCalled()
    close()
  })

  it('keeps host-contact failure separate from unsupported versions', async () => {
    const { guarded } = setup(async () => {
      throw new Error('offline')
    })
    expect(await guarded.readSession('antigravity', 'conversation')).toEqual({
      error: RUNTIME_NATIVE_CHAT_READ_ERROR
    })
  })

  it('does not open a subscription after teardown while the probe was pending', async () => {
    let resolve: ((supported: boolean) => void) | undefined
    const { guarded, transport } = setup(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const close = await guarded.subscribe(args, vi.fn())
    close()
    resolve?.(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.subscribe).not.toHaveBeenCalled()
  })

  it('uses supported hosts and closes their subscription once', async () => {
    const { guarded, transport, stop } = setup(async () => true)
    await guarded.readSession('antigravity', 'conversation')
    expect(transport.readSession).toHaveBeenCalledWith('antigravity', 'conversation')
    const close = await guarded.subscribe(args, vi.fn())
    await vi.waitFor(() => expect(transport.subscribe).toHaveBeenCalledOnce())
    close()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('leaves existing agents on their existing transport', async () => {
    const supports = vi.fn(async () => false)
    const { guarded, transport } = setup(supports)
    await guarded.readSession('claude', 'conversation')
    await guarded.subscribe({ ...args, agent: 'claude' }, vi.fn())
    expect(transport.readSession).toHaveBeenCalledOnce()
    expect(transport.subscribe).toHaveBeenCalledOnce()
    expect(supports).not.toHaveBeenCalled()
  })
})
