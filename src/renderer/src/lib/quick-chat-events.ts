import { isWebClientLocation } from './web-client-location'

export const QUICK_CHAT_EVENT = 'orca:quick-chat'
export const QUICK_CHAT_FINISHED_EVENT = 'orca:quick-chat-finished'
export const QUICK_CHAT_ANCHOR_EVENT = 'orca:quick-chat-anchor'
let sequence = 0

export function requestQuickChat(control?: HTMLElement): string | null {
  if (isWebClientLocation()) {
    return null
  }
  const id = `quick-chat-${++sequence}`
  window.dispatchEvent(new CustomEvent(QUICK_CHAT_EVENT, { detail: { id, control } }))
  return id
}

export function requestQuickChatFromShortcut(): void {
  requestQuickChat()
}
