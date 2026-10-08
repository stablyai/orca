// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getNativeViewOcclusionSnapshot,
  subscribeNativeViewOcclusion
} from '@/lib/native-view-occlusion'
import { useNativeViewOcclusionRef } from './useNativeViewOcclusion'

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

describe('useNativeViewOcclusionRef', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  it('runs callback-ref cleanup once without releasing a replacement node', () => {
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    const listener = subscribeNativeViewOcclusion(() => undefined)
    const cleanup = vi.fn()
    const forwarded = vi.fn(() => cleanup)
    const { result } = renderHook(() => useNativeViewOcclusionRef<HTMLDivElement>(forwarded))
    const first = document.createElement('div')
    const second = document.createElement('div')
    document.body.append(first, second)
    for (const element of [first, second]) {
      Object.defineProperty(element, 'getBoundingClientRect', {
        value: () => new DOMRect(1, 2, 3, 4)
      })
    }
    const firstCleanup = result.current(first)!
    const secondCleanup = result.current(second)!
    firstCleanup()
    expect(getNativeViewOcclusionSnapshot().rectangles).toHaveLength(1)
    secondCleanup()
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(forwarded).toHaveBeenLastCalledWith(null)
    listener()
  })

  it('releases its element when React invokes callback-ref cleanup', () => {
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    const listener = subscribeNativeViewOcclusion(() => undefined)
    const { result } = renderHook(() => useNativeViewOcclusionRef<HTMLDivElement>())
    const element = document.createElement('div')
    document.body.append(element)
    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => new DOMRect(1, 2, 3, 4)
    })
    const cleanup = result.current(element)
    expect(getNativeViewOcclusionSnapshot().rectangles).toHaveLength(1)
    cleanup?.()
    expect(getNativeViewOcclusionSnapshot().rectangles).toEqual([])
    listener()
  })
})
