// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useComposerDropListener } from './composer-drop-listener'
import type { NativeFileDropPayload } from '../../../../shared/native-file-drop'

let originalApiDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
  const ui = {
    onFileDrop: vi.fn<Window['api']['ui']['onFileDrop']>()
  } satisfies Pick<Window['api']['ui'], 'onFileDrop'>
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('useComposerDropListener', () => {
  it('routes to the newest composer and restores the previous owner after cleanup', () => {
    const listeners: ((data: NativeFileDropPayload) => void)[] = []
    const unsubscribes: (() => void)[] = []
    vi.spyOn(window.api.ui, 'onFileDrop').mockImplementation((listener) => {
      listeners.push(listener)
      const unsubscribe = vi.fn()
      unsubscribes.push(unsubscribe)
      return unsubscribe
    })
    const firstApply = vi.fn()
    const secondApply = vi.fn()
    const first = renderHook(() => useComposerDropListener(firstApply))
    const second = renderHook(() => useComposerDropListener(secondApply))

    act(() => {
      for (const listener of listeners) {
        listener({ target: 'composer', paths: ['/tmp/newest.txt'] })
      }
    })
    expect(firstApply).not.toHaveBeenCalled()
    expect(secondApply).toHaveBeenCalledTimes(1)

    second.unmount()
    expect(unsubscribes[1]).toHaveBeenCalledTimes(1)
    act(() => {
      listeners[0]({ target: 'composer', paths: ['/tmp/restored.txt'] })
    })
    expect(firstApply).toHaveBeenCalledTimes(1)

    first.unmount()
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1)
  })
})
