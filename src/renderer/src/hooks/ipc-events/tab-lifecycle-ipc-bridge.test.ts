// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'
import { registerTabLifecycleIpcBridge } from './tab-lifecycle-ipc-bridge'

describe('browser shortcut replay', () => {
  it('replays a forwarded Plugins chord through app keyboard owners', () => {
    let forward:
      | ((input: { key: string; code: string; shift: boolean; meta: boolean }) => void)
      | undefined
    const unsubscribe = vi.fn()
    const ui = {
      onBrowserPageTabShortcut: (listener: typeof forward) => {
        forward = listener
        return unsubscribe
      },
      onCloseActiveTab: () => unsubscribe,
      onCloseFloatingItem: () => unsubscribe,
      onSelectFloatingIndex: () => unsubscribe,
      onSwitchRecentTab: () => unsubscribe
    }
    vi.stubGlobal('api', {})
    Object.defineProperty(window, 'api', { configurable: true, value: { ui } })
    const listener = vi.fn()
    addAppKeyListener('keydown', listener)
    const unsubs: (() => void)[] = []
    registerTabLifecycleIpcBridge(unsubs)
    forward?.({ key: 'X', code: 'KeyX', shift: true, meta: true })
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0][0]).toMatchObject({
      key: 'X',
      code: 'KeyX',
      shiftKey: true,
      metaKey: true
    })
    removeAppKeyListener('keydown', listener)
    unsubs.forEach((fn) => fn())
    vi.unstubAllGlobals()
  })
})
