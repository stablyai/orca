// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopAppWindow } from '../../../../shared/desktop-app-types'
import { useDesktopAppWindows } from './use-desktop-app-windows'

function appWindow(windowId: number, pid: number, title = 'Doc'): DesktopAppWindow {
  return {
    windowId,
    pid,
    appName: 'App',
    bundleId: null,
    title,
    bounds: { x: 0, y: 0, width: 100, height: 100 }
  }
}

const listWindows = vi.fn<() => Promise<DesktopAppWindow[]>>()

describe('useDesktopAppWindows', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear()
    Object.defineProperty(window, 'api', {
      value: { desktopApp: { listWindows } },
      configurable: true
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  async function refreshWith(
    result: { current: ReturnType<typeof useDesktopAppWindows> },
    windows: DesktopAppWindow[]
  ) {
    listWindows.mockResolvedValueOnce(windows)
    await act(async () => result.current.refresh())
  }

  it('re-selects the chosen window when it shows up in the list again', async () => {
    const chosen = appWindow(7, 42)
    const { result } = renderHook(() => useDesktopAppWindows('tab', false))
    await refreshWith(result, [chosen])
    act(() => result.current.select({ windowId: 7, pid: 42 }))
    expect(result.current.selected).toEqual(chosen)

    await refreshWith(result, [])
    expect(result.current.selected).toBeNull()

    await refreshWith(result, [chosen])
    expect(result.current.selected).toEqual(chosen)
  })

  it('never re-selects a window id that now belongs to another process', async () => {
    const { result } = renderHook(() => useDesktopAppWindows('tab', false))
    await refreshWith(result, [appWindow(7, 42)])
    act(() => result.current.select({ windowId: 7, pid: 42 }))

    await refreshWith(result, [appWindow(7, 99)])
    expect(result.current.selected).toBeNull()
  })

  it('restores the remembered window and then pins that exact window', async () => {
    const first = renderHook(() => useDesktopAppWindows('tab', false))
    await refreshWith(first.result, [appWindow(7, 42, 'Notes')])
    act(() => first.result.current.select({ windowId: 7, pid: 42 }))
    first.unmount()

    // Ids changed after a relaunch: the restore falls back to the same app and title.
    const { result } = renderHook(() => useDesktopAppWindows('tab', false))
    const relaunched = appWindow(8, 50, 'Notes')
    await refreshWith(result, [appWindow(9, 50, 'Other'), relaunched])
    expect(result.current.selected).toEqual(relaunched)

    await refreshWith(result, [appWindow(9, 50, 'Notes')])
    expect(result.current.selected).toBeNull()
  })
})
