import { describe, expect, it, vi } from 'vitest'
import {
  canAutoLoadEarlier,
  createNativeChatLoadEarlierController,
  NATIVE_CHAT_LOAD_EARLIER_ERROR,
  startNativeChatLoadEarlier,
  type NativeChatLoadEarlierState
} from './native-chat-load-earlier'

type Result = { messages: string[] } | { error: string }

describe('native chat load earlier', () => {
  it('keeps automatic paging off after a failed page', () => {
    expect(canAutoLoadEarlier(true, false, NATIVE_CHAT_LOAD_EARLIER_ERROR)).toBe(false)
  })

  it('allows one request at a time and retries only after the failed request settles', async () => {
    const settlements: ((result: Result) => void)[] = []
    const read = vi.fn(
      () =>
        new Promise<Result>((resolve) => {
          settlements.push(resolve)
        })
    )
    const apply = vi.fn()
    const states: NativeChatLoadEarlierState[] = []
    const controller = createNativeChatLoadEarlierController()
    const start = (): void =>
      startNativeChatLoadEarlier({
        controller,
        read,
        isSuccess: (result): result is { messages: string[] } => 'messages' in result,
        apply,
        setState: (state) => states.push(state)
      })

    start()
    start()
    start()
    expect(read).toHaveBeenCalledOnce()

    settlements[0]?.({ error: 'offline' })
    await Promise.resolve()
    expect(states.at(-1)).toEqual({
      loadingEarlier: false,
      loadEarlierError: NATIVE_CHAT_LOAD_EARLIER_ERROR
    })

    start()
    expect(read).toHaveBeenCalledTimes(2)
    settlements[1]?.({ messages: ['older'] })
    await Promise.resolve()

    expect(apply).toHaveBeenCalledOnce()
    expect(states.at(-1)).toEqual({ loadingEarlier: false, loadEarlierError: null })
  })

  it('drops a failure after the source invalidates its request', async () => {
    let reject: (reason: unknown) => void = () => {}
    const states: NativeChatLoadEarlierState[] = []
    const controller = createNativeChatLoadEarlierController()

    startNativeChatLoadEarlier({
      controller,
      read: () =>
        new Promise<Result>((_resolve, rejectRequest) => {
          reject = rejectRequest
        }),
      isSuccess: (result): result is { messages: string[] } => 'messages' in result,
      apply: vi.fn(),
      setState: (state) => states.push(state)
    })
    controller.invalidate()
    reject(new Error('disconnected'))
    await Promise.resolve()

    expect(states).toEqual([{ loadingEarlier: true, loadEarlierError: null }])
  })
})
