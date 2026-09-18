import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NATIVE_CHAT_SEND_SHORTCUT,
  normalizeNativeChatSendShortcut
} from './native-chat-send-shortcut'

describe('normalizeNativeChatSendShortcut', () => {
  it('defaults to Enter for missing or invalid persisted values', () => {
    expect(DEFAULT_NATIVE_CHAT_SEND_SHORTCUT).toBe('enter')
    expect(normalizeNativeChatSendShortcut(undefined)).toBe('enter')
    expect(normalizeNativeChatSendShortcut('unexpected')).toBe('enter')
  })

  it('preserves supported shortcuts', () => {
    expect(normalizeNativeChatSendShortcut('enter')).toBe('enter')
    expect(normalizeNativeChatSendShortcut('cmd-or-ctrl-enter')).toBe('cmd-or-ctrl-enter')
  })
})
