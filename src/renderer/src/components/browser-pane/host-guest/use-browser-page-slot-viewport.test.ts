// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { registerBrowserOverlaySlotViewport } from './browser-page-viewport'
import { useBrowserPageSlotViewport } from './use-browser-page-slot-viewport'

afterEach(() => {
  registerBrowserOverlaySlotViewport('workspace-1', null)
})

describe('useBrowserPageSlotViewport', () => {
  it('updates when a mounted slot root is replaced', () => {
    const first = document.createElement('div')
    const second = document.createElement('div')
    registerBrowserOverlaySlotViewport('workspace-1', first)
    const { result } = renderHook(() => useBrowserPageSlotViewport('workspace-1'))

    expect(result.current).toBe(first)

    act(() => {
      registerBrowserOverlaySlotViewport('workspace-1', null)
      registerBrowserOverlaySlotViewport('workspace-1', second)
    })

    expect(result.current).toBe(second)
  })
})
