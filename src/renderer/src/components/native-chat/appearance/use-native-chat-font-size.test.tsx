// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatAppearanceSettings } from '../../../../../shared/native-chat/settings/native-chat-appearance-settings'
import type { KeybindingOverrides } from '../../../../../shared/keybindings/types'
import { isMacPlatform } from '../pane/routing/native-chat-shortcut'

const mocks = vi.hoisted(() => {
  const settings: { nativeChatAppearance?: NativeChatAppearanceSettings } = {}
  const updateSettings = vi.fn(async (updates: typeof settings) => {
    Object.assign(settings, updates)
  })
  const bindings: { current?: KeybindingOverrides } = {}
  return { settings, updateSettings, bindings, web: true }
})
vi.mock('../../../store/index', () => ({
  useAppStore: { getState: () => ({ ...mocks, keybindings: mocks.bindings.current }) }
}))
vi.mock('@/app-shell/platform/web-client-location', () => ({
  isWebClientLocation: () => mocks.web
}))

import { useNativeChatFontSize } from './use-native-chat-font-size'

function key(keyName: string, target: EventTarget = window): KeyboardEvent {
  const code =
    keyName === '+'
      ? 'Equal'
      : keyName === '-' || keyName === '_'
        ? 'Minus'
        : keyName === '0'
          ? 'Digit0'
          : `Key${keyName.toUpperCase()}`
  const event = new KeyboardEvent('keydown', {
    key: keyName,
    code,
    bubbles: true,
    cancelable: true,
    metaKey: isMacPlatform(),
    ctrlKey: !isMacPlatform(),
    shiftKey: keyName === '+' || keyName === '_'
  })
  target.dispatchEvent(event)
  return event
}

function wheel(target: EventTarget, deltaY: number): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY })
  Object.defineProperty(event, 'ctrlKey', { value: true })
  target.dispatchEvent(event)
  return event
}

afterEach(() => {
  cleanup()
  mocks.web = true
  delete mocks.bindings.current
  delete mocks.settings.nativeChatAppearance
  mocks.updateSettings.mockClear()
})

describe('persisted chat font-size shortcuts', () => {
  it('consumes matching chat size keys without writing when the chat matches the terminal', async () => {
    mocks.settings.nativeChatAppearance = { fontSize: 18, matchTerminalInterface: true }
    renderHook(() => useNativeChatFontSize(true))
    const events: KeyboardEvent[] = []
    act(() => {
      events.push(key('+'), key('-'), key('0'))
    })
    await Promise.resolve()
    expect(events.every((event) => event.defaultPrevented)).toBe(true)
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(mocks.settings.nativeChatAppearance).toEqual({
      fontSize: 18,
      matchTerminalInterface: true
    })
  })

  it('serializes quick repeats against the latest stored size, clamps, and resets only text size', async () => {
    mocks.settings.nativeChatAppearance = { fontSize: 19, codeFontSize: 16, width: 'wide' }
    renderHook(() => useNativeChatFontSize(true))
    act(() => {
      key('+')
      key('+')
      key('-')
    })
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledTimes(2))
    expect(mocks.settings.nativeChatAppearance).toEqual({
      fontSize: 19,
      codeFontSize: 16,
      width: 'wide'
    })
    act(() => key('0'))
    await waitFor(() =>
      expect(mocks.settings.nativeChatAppearance).toEqual({ codeFontSize: 16, width: 'wide' })
    )
  })

  it('only handles keys originating in its chat root', async () => {
    const root = document.createElement('div')
    const input = document.createElement('input')
    root.append(input)
    document.body.append(root)
    renderHook(() => useNativeChatFontSize(true, { current: root }))
    key('+')
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    key('-', input)
    await waitFor(() => expect(mocks.settings.nativeChatAppearance).toEqual({ fontSize: 12 }))
    root.remove()
  })

  it('handles configured web bindings and leaves old or disabled chords alone', async () => {
    mocks.bindings.current = {
      'zoom.in': ['Mod+Y'],
      'zoom.out': ['Mod+U'],
      'zoom.reset': []
    }
    renderHook(() => useNativeChatFontSize(true))
    key('+')
    key('0')
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    key('y')
    await waitFor(() => expect(mocks.settings.nativeChatAppearance).toEqual({ fontSize: 14 }))
    key('u')
    await waitFor(() => expect(mocks.settings.nativeChatAppearance).toBeUndefined())
    expect(mocks.updateSettings).toHaveBeenCalledTimes(2)
  })

  it('steps text size from a pinch on an unfocused chat and leaves other wheels alone', async () => {
    mocks.web = false
    const root = document.createElement('div')
    const text = document.createElement('p')
    root.append(text)
    document.body.append(root)
    renderHook(() => useNativeChatFontSize(false, { current: root }, true))
    expect(wheel(text, -4).defaultPrevented).toBe(true)
    await Promise.resolve()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    wheel(text, -4)
    wheel(text, -4)
    wheel(text, -4)
    await waitFor(() => expect(mocks.settings.nativeChatAppearance).toEqual({ fontSize: 14 }))
    const scroll = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -8 })
    text.dispatchEvent(scroll)
    const outside = wheel(document.body, -8)
    await Promise.resolve()
    expect(mocks.updateSettings).toHaveBeenCalledTimes(1)
    expect(outside.defaultPrevented).toBe(false)
    root.remove()
  })

  it('keeps pinch travel regardless of wheel event grouping', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    renderHook(() => useNativeChatFontSize(false, { current: root }, true))
    wheel(root, -24)
    await waitFor(() => expect(mocks.settings.nativeChatAppearance).toEqual({ fontSize: 15 }))
    expect(mocks.updateSettings).toHaveBeenCalledTimes(2)
    root.remove()
  })
})
