// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useNativeChatHoverPreview } from './use-native-chat-hover-preview'
import {
  clearLinearLinkPreviews,
  linearLinkPreviewKey,
  useLinearPreviewGeneration
} from './native-chat-linear-link-preview'

afterEach(cleanup)

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('useNativeChatHoverPreview', () => {
  it('drops the old answer as soon as the key changes', async () => {
    const answers = new Map<string, string>([['a', 'first']])
    const pending = deferred<string | null>()
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) =>
        useNativeChatHoverPreview(
          key,
          () => answers.get(key) ?? null,
          () => (key === 'a' ? Promise.resolve('first') : pending.promise)
        ),
      { initialProps: { key: 'a' } }
    )
    expect(result.current.state).toEqual({ status: 'ready', value: 'first' })

    rerender({ key: 'b' })
    expect(result.current.state).toEqual({ status: 'loading' })

    await act(async () => pending.resolve('second'))
    expect(result.current.state).toEqual({ status: 'ready', value: 'second' })
  })

  it('ignores an answer for an earlier key', async () => {
    const slow = deferred<string | null>()
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) =>
        useNativeChatHoverPreview(
          key,
          () => null,
          () => (key === 'a' ? slow.promise : new Promise<string | null>(() => {}))
        ),
      { initialProps: { key: 'a' } }
    )
    rerender({ key: 'b' })
    await act(async () => slow.resolve('stale'))
    expect(result.current.state).toEqual({ status: 'loading' })
  })
})

describe('Linear preview generation', () => {
  it('moves every Linear preview key on an account change and re-renders subscribers', () => {
    const link = { orgUrlKey: 'acme', identifier: 'ENG-1' }
    const before = linearLinkPreviewKey(link)
    const { result } = renderHook(() => useLinearPreviewGeneration())
    const generation = result.current

    act(() => clearLinearLinkPreviews())

    expect(result.current).toBe(generation + 1)
    expect(linearLinkPreviewKey(link)).not.toBe(before)
  })
})
