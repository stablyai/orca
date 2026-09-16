const TERMINAL_PASTE_OVERLAY_SELECTOR = [
  '[data-terminal-search-root]',
  '[data-native-chat-root="true"]',
  '.terminal-rich-input-dock'
].join(',')

export function terminalPasteIsOwnedByOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TERMINAL_PASTE_OVERLAY_SELECTOR) !== null
}
