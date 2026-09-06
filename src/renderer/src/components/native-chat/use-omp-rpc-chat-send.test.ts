// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  resolveOmpRpcChatSendBehavior,
  useOmpRpcChatSend,
  type UseOmpRpcChatSendArgs
} from './use-omp-rpc-chat-send'

function args(overrides: Partial<UseOmpRpcChatSendArgs> = {}): UseOmpRpcChatSendArgs {
  return {
    isRpcOwned: true,
    isRpcTurnWorking: false,
    followUpRequested: false,
    sessionGeneration: 0,
    sendChat: vi.fn().mockResolvedValue({ ok: true, agentInvoked: true }),
    ...overrides
  }
}

describe('resolveOmpRpcChatSendBehavior', () => {
  it('sends idle as prompt', () => {
    expect(resolveOmpRpcChatSendBehavior(false, false)).toBe('idle')
    expect(resolveOmpRpcChatSendBehavior(false, true)).toBe('idle')
  })

  it('defaults a working turn to steer', () => {
    expect(resolveOmpRpcChatSendBehavior(true, false)).toBe('steer')
  })

  it('routes to follow_up only when the Follow up affordance is armed', () => {
    expect(resolveOmpRpcChatSendBehavior(true, true)).toBe('followUp')
  })
})

describe('useOmpRpcChatSend', () => {
  it('does not claim the draft when the pane is not RPC-owned (D1 degrade)', () => {
    const { result } = renderHook(() => useOmpRpcChatSend(args({ isRpcOwned: false })))
    expect(result.current('hello')).toBe(false)
  })

  it('does not claim a blank draft', () => {
    const { result } = renderHook(() => useOmpRpcChatSend(args()))
    expect(result.current('   ')).toBe(false)
  })

  it('claims an idle send as prompt and echoes an optimistic bubble', () => {
    const sendChat = vi.fn().mockResolvedValue({ ok: true, agentInvoked: true })
    const onOptimisticSend = vi.fn()
    const { result } = renderHook(() => useOmpRpcChatSend(args({ sendChat, onOptimisticSend })))

    expect(result.current('hello')).toBe(true)

    expect(onOptimisticSend).toHaveBeenCalledWith('hello', [])
    expect(sendChat).toHaveBeenCalledWith({ message: 'hello', behavior: 'idle' })
  })

  it('steers a working turn by default', () => {
    const sendChat = vi.fn().mockResolvedValue({ ok: true, agentInvoked: true })
    const { result } = renderHook(() =>
      useOmpRpcChatSend(args({ isRpcTurnWorking: true, sendChat }))
    )

    result.current('interject')

    expect(sendChat).toHaveBeenCalledWith({ message: 'interject', behavior: 'steer' })
  })

  it('routes to follow_up when the composer armed the affordance', () => {
    const sendChat = vi.fn().mockResolvedValue({ ok: true, agentInvoked: true })
    const { result } = renderHook(() =>
      useOmpRpcChatSend(args({ isRpcTurnWorking: true, followUpRequested: true, sendChat }))
    )

    result.current('later')

    expect(sendChat).toHaveBeenCalledWith({ message: 'later', behavior: 'followUp' })
  })

  it('reports a failed send after already claiming the draft, without a PTY fallback', async () => {
    const sendChat = vi.fn().mockResolvedValue({ ok: false, reason: 'disposed' })
    const onSendFailed = vi.fn()
    const { result } = renderHook(() => useOmpRpcChatSend(args({ sendChat, onSendFailed })))

    const claimed = result.current('hello')

    expect(claimed).toBe(true)
    await waitFor(() => expect(onSendFailed).toHaveBeenCalledTimes(1))
  })

  it('records a rejected send as durable pane feedback once the composer unmounts', async () => {
    // Toggling Chat -> Terminal unmounts the composer while the round trip is
    // still open. The local notice is composer `useState`, so a post-unmount
    // write is discarded: the user returns to a pane that shows the optimistic
    // bubble and no sign the message never reached the agent.
    let reject: ((error: Error) => void) | undefined
    const sendChat = vi.fn(
      () =>
        new Promise<never>((_resolve, settle) => {
          reject = settle
        })
    )
    const onSendFailed = vi.fn()
    const onMessageFailed = vi.fn()
    const hook = renderHook(() =>
      useOmpRpcChatSend(args({ sendChat, onSendFailed, onMessageFailed }))
    )

    expect(hook.result.current('hello')).toBe(true)
    hook.unmount()
    await act(async () => {
      reject?.(new Error('handler torn down'))
    })

    expect(onMessageFailed).toHaveBeenCalledTimes(1)
    expect(onSendFailed).not.toHaveBeenCalled()
  })

  it('records a DECLINED send as durable pane feedback once the composer unmounts', async () => {
    let settle: ((value: { ok: false; reason: string }) => void) | undefined
    const sendChat = vi.fn(
      () =>
        new Promise<{ ok: false; reason: string }>((resolve) => {
          settle = resolve
        })
    )
    const onSendFailed = vi.fn()
    const onMessageFailed = vi.fn()
    const hook = renderHook(() =>
      useOmpRpcChatSend(args({ sendChat, onSendFailed, onMessageFailed }))
    )

    expect(hook.result.current('hello')).toBe(true)
    hook.unmount()
    await act(async () => {
      settle?.({ ok: false, reason: 'disposed' })
    })

    expect(onMessageFailed).toHaveBeenCalledTimes(1)
    expect(onSendFailed).not.toHaveBeenCalled()
  })

  it('keeps reporting locally while mounted, including across StrictMode replay', async () => {
    // The durable notice is the unmounted fallback, never a replacement: a
    // mounted composer must not also write pane state that its own remount
    // would replay. StrictMode's setup -> cleanup -> setup must not be read as
    // an unmount.
    const sendChat = vi.fn().mockRejectedValue(new Error('handler torn down'))
    const onSendFailed = vi.fn()
    const onMessageFailed = vi.fn()
    const hook = renderHook(
      () => useOmpRpcChatSend(args({ sendChat, onSendFailed, onMessageFailed })),
      { wrapper: StrictMode }
    )

    await act(async () => {
      hook.result.current('hello')
    })

    expect(onSendFailed).toHaveBeenCalledTimes(1)
    expect(onMessageFailed).not.toHaveBeenCalled()
  })

  it('reports the durable notice under the generation the message was sent on', async () => {
    // The durable route is paneKey-scoped state, and a paneKey survives a
    // rebind. Without the dispatch generation riding along, a rejection that
    // settles after the pane rebound writes this message's failure into the
    // replacement session's composer.
    let reject: ((error: Error) => void) | undefined
    const sendChat = vi.fn(
      () =>
        new Promise<never>((_resolve, settle) => {
          reject = settle
        })
    )
    const onMessageFailed = vi.fn()
    const hook = renderHook(
      (props: { sessionGeneration: number }) =>
        useOmpRpcChatSend(args({ sendChat, onMessageFailed, ...props })),
      { initialProps: { sessionGeneration: 3 } }
    )

    expect(hook.result.current('hello')).toBe(true)
    // The pane rebinds to a replacement session while the round trip is open.
    hook.rerender({ sessionGeneration: 4 })
    hook.unmount()
    await act(async () => {
      reject?.(new Error('handler torn down'))
    })

    expect(onMessageFailed).toHaveBeenCalledWith(3)
  })

  it('surfaces a send superseded mid-flight in the composer that is still mounted', async () => {
    // Routing this to the durable reporter is silence, not fencing: that
    // reporter drops any report whose generation is not the row's current one,
    // so a superseded report can never land. Meanwhile the optimistic echo is
    // pane+agent-scoped (NativeChatResolvedView's pendingScope carries no
    // generation), so it outlives the rebind and still reads as sent. The
    // mounted composer is the only surface left that can correct it.
    let reject: ((error: Error) => void) | undefined
    const sendChat = vi.fn(
      () =>
        new Promise<never>((_resolve, settle) => {
          reject = settle
        })
    )
    const onSendFailed = vi.fn()
    const onMessageFailed = vi.fn()
    const hook = renderHook(
      (props: { sessionGeneration: number }) =>
        useOmpRpcChatSend(args({ sendChat, onSendFailed, onMessageFailed, ...props })),
      { initialProps: { sessionGeneration: 3 } }
    )

    expect(hook.result.current('hello')).toBe(true)
    // Rebound to a replacement session, but never unmounted.
    hook.rerender({ sessionGeneration: 4 })
    await act(async () => {
      reject?.(new Error('handler torn down'))
    })

    expect(onSendFailed).toHaveBeenCalledTimes(1)
    expect(onMessageFailed).not.toHaveBeenCalled()
  })

  it('surfaces a DECLINED superseded send in the composer that is still mounted', async () => {
    let settle: ((value: { ok: false; reason: string }) => void) | undefined
    const sendChat = vi.fn(
      () =>
        new Promise<{ ok: false; reason: string }>((resolve) => {
          settle = resolve
        })
    )
    const onSendFailed = vi.fn()
    const onMessageFailed = vi.fn()
    const hook = renderHook(
      (props: { sessionGeneration: number }) =>
        useOmpRpcChatSend(args({ sendChat, onSendFailed, onMessageFailed, ...props })),
      { initialProps: { sessionGeneration: 3 } }
    )

    expect(hook.result.current('hello')).toBe(true)
    hook.rerender({ sessionGeneration: 4 })
    await act(async () => {
      settle?.({ ok: false, reason: 'disposed' })
    })

    expect(onSendFailed).toHaveBeenCalledTimes(1)
    expect(onMessageFailed).not.toHaveBeenCalled()
  })

  it('retracts the optimistic echo of a send that failed', async () => {
    // The echo renders as a message already handed to the agent. A notice
    // beside it is not a correction on its own: the bubble is the claim, so a
    // failed send has to take the bubble back too.
    const sendChat = vi.fn().mockResolvedValue({ ok: false, reason: 'disposed' })
    const onOptimisticSend = vi.fn().mockReturnValue('pending-1')
    const onOptimisticSendCanceled = vi.fn()
    const { result } = renderHook(() =>
      useOmpRpcChatSend(args({ sendChat, onOptimisticSend, onOptimisticSendCanceled }))
    )

    expect(result.current('hello')).toBe(true)

    await waitFor(() => expect(onOptimisticSendCanceled).toHaveBeenCalledWith('pending-1'))
  })

  it('retracts the echo of a REJECTED send too', async () => {
    const sendChat = vi.fn().mockRejectedValue(new Error('handler torn down'))
    const onOptimisticSend = vi.fn().mockReturnValue('pending-1')
    const onOptimisticSendCanceled = vi.fn()
    const { result } = renderHook(() =>
      useOmpRpcChatSend(args({ sendChat, onOptimisticSend, onOptimisticSendCanceled }))
    )

    expect(result.current('hello')).toBe(true)

    await waitFor(() => expect(onOptimisticSendCanceled).toHaveBeenCalledWith('pending-1'))
  })

  it('leaves the echo alone when the send succeeds', async () => {
    const onOptimisticSend = vi.fn().mockReturnValue('pending-1')
    const onOptimisticSendCanceled = vi.fn()
    const { result } = renderHook(() =>
      useOmpRpcChatSend(args({ onOptimisticSend, onOptimisticSendCanceled }))
    )

    await act(async () => {
      result.current('hello')
    })

    expect(onOptimisticSendCanceled).not.toHaveBeenCalled()
  })

  it('retracts the echo when the composer has unmounted AND the pane rebound', async () => {
    // The case neither notice route can reach: the local notice needs a mounted
    // composer, and the durable notice is worded for a rebind rather than
    // blamed on the replacement session. The echo itself is retractable in
    // both states because it lives in the module-level pane cache
    // (native-chat-pending.ts) that NativeChatResolvedView's canceler writes
    // through, keyed by pendingId — so exactly this send's bubble is removed,
    // never the replacement session's own.
    let reject: ((error: Error) => void) | undefined
    const sendChat = vi.fn(
      () =>
        new Promise<never>((_resolve, settle) => {
          reject = settle
        })
    )
    const onOptimisticSend = vi.fn().mockReturnValue('pending-1')
    const onOptimisticSendCanceled = vi.fn()
    const onSendFailed = vi.fn()
    const onMessageFailed = vi.fn()
    const hook = renderHook(
      (props: { sessionGeneration: number }) =>
        useOmpRpcChatSend(
          args({
            sendChat,
            onOptimisticSend,
            onOptimisticSendCanceled,
            onSendFailed,
            onMessageFailed,
            ...props
          })
        ),
      { initialProps: { sessionGeneration: 3 } }
    )

    expect(hook.result.current('hello')).toBe(true)
    hook.rerender({ sessionGeneration: 4 })
    hook.unmount()
    await act(async () => {
      reject?.(new Error('handler torn down'))
    })

    expect(onOptimisticSendCanceled).toHaveBeenCalledWith('pending-1')
    expect(onMessageFailed).toHaveBeenCalledWith(3)
    expect(onSendFailed).not.toHaveBeenCalled()
  })

  it('reports a rejected send rather than leaving an unhandled rejection', async () => {
    // A round trip that REJECTS (handler teardown, destroyed window) costs the
    // draft exactly as a declined `{ ok: false }` does, and an RPC-owned pane
    // has no PTY left to retype into. Attaching only a fulfillment handler let
    // the rejection escape to `unhandledrejection` with no notice shown.
    const sendChat = vi.fn().mockRejectedValue(new Error('handler torn down'))
    const onSendFailed = vi.fn()
    const { result } = renderHook(() => useOmpRpcChatSend(args({ sendChat, onSendFailed })))

    expect(result.current('hello')).toBe(true)

    // The escaping rejection is caught by the runner itself, which fails this
    // file on an unhandled rejection — no hand-rolled listener needed.
    await waitFor(() => expect(onSendFailed).toHaveBeenCalledTimes(1))
  })
})
