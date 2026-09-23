export type NativeChatSendShortcut = 'enter' | 'cmd-or-ctrl-enter'

export const DEFAULT_NATIVE_CHAT_SEND_SHORTCUT: NativeChatSendShortcut = 'enter'

/** Converts persisted values to one of the supported Native Chat shortcuts. */
export function normalizeNativeChatSendShortcut(value: unknown): NativeChatSendShortcut {
  return value === 'cmd-or-ctrl-enter' ? value : DEFAULT_NATIVE_CHAT_SEND_SHORTCUT
}
