// Why: the chat view is portaled over its terminal pane, and xterm's helper textarea
// can keep focus under it while the chat mounts. A paste the terminal catches then
// belongs to the chat, not to the PTY hidden underneath.
export const NATIVE_CHAT_PASTE_REQUEST_EVENT = 'orca-native-chat-paste-request'

const NATIVE_CHAT_ROOT_SELECTOR = '[data-native-chat-root="true"]'

/** Hands a paste to the chat overlaying `container`; true when a chat input took it. */
export function requestNativeChatOverlayPaste(container: Element): boolean {
  const root = container.querySelector(NATIVE_CHAT_ROOT_SELECTOR)
  if (!root) {
    return false
  }
  const event = new CustomEvent(NATIVE_CHAT_PASTE_REQUEST_EVENT, { cancelable: true })
  root.dispatchEvent(event)
  return event.defaultPrevented
}
