// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const shortcutStore = vi.hoisted((): { value: unknown } => ({ value: undefined }))

vi.mock('../../store', () => ({
  useAppStore: (
    selector: (state: { settings?: { nativeChatSendShortcut?: unknown } }) => unknown
  ) => selector({ settings: { nativeChatSendShortcut: shortcutStore.value } })
}))

import { useNativeChatSendShortcut } from './use-native-chat-send-shortcut'

describe('useNativeChatSendShortcut', () => {
  it.each([
    [undefined, 'enter'],
    ['enter', 'enter'],
    ['cmd-or-ctrl-enter', 'cmd-or-ctrl-enter'],
    ['unsupported', 'enter']
  ])('normalizes the configured %s value to %s', (configured, expected) => {
    shortcutStore.value = configured

    const { result } = renderHook(() => useNativeChatSendShortcut())

    expect(result.current).toBe(expected)
  })

  it('uses an explicit override for isolated consumers', () => {
    shortcutStore.value = 'enter'

    const { result } = renderHook(() => useNativeChatSendShortcut('cmd-or-ctrl-enter'))

    expect(result.current).toBe('cmd-or-ctrl-enter')
  })
})
