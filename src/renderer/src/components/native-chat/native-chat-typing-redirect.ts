export type KeyboardRedirectEvent = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey?: boolean
  altKey?: boolean
  defaultPrevented: boolean
  isComposing?: boolean
  target: EventTarget | null
}

// Plain pressables use only Space and Enter, so other keys may pass them to the chat's input.
const PRESSABLE_TARGET_SELECTOR = ['a[href]', 'button', '[role="button"]'].join(',')

const KEY_OWNER_TARGET_SELECTOR = [
  'input',
  'select',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="switch"]',
  '[role="textbox"]',
  '[data-native-chat-typing-redirect-ignore="true"]'
].join(',')

export function shouldRedirectNativeChatTyping(
  event: KeyboardRedirectEvent,
  isMac: boolean
): boolean {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    // Option types characters on macOS; elsewhere Alt+key is a shortcut.
    (event.altKey === true && !isMac) ||
    event.key.length !== 1
  ) {
    return false
  }
  if (targetMatches(event.target, KEY_OWNER_TARGET_SELECTOR)) {
    return false
  }
  return event.key !== ' ' || !targetMatches(event.target, PRESSABLE_TARGET_SELECTOR)
}

export function shouldFocusNativeChatPaneFromPointerTarget(target: EventTarget | null): boolean {
  return (
    !targetMatches(target, PRESSABLE_TARGET_SELECTOR) &&
    !targetMatches(target, KEY_OWNER_TARGET_SELECTOR)
  )
}

/** Unmodified editing keys outside inputs focus without inserting; modified delete/cut chords remain with the target. */
export function shouldFocusNativeChatComposerFromEditingKey(event: KeyboardRedirectEvent): boolean {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey ||
    (event.key !== 'Backspace' && event.key !== 'Delete')
  ) {
    return false
  }
  return !targetMatches(event.target, KEY_OWNER_TARGET_SELECTOR)
}

/** Focus input before the native paste following this platform chord arrives. */
export function shouldFocusNativeChatInputForPaste(
  event: KeyboardRedirectEvent,
  isMac: boolean
): boolean {
  if (event.defaultPrevented || event.isComposing || event.altKey) {
    return false
  }
  const chord = isMac
    ? event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'v'
    : (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'v') ||
      (event.shiftKey === true && !event.ctrlKey && !event.metaKey && event.key === 'Insert')
  return chord && !targetMatches(event.target, KEY_OWNER_TARGET_SELECTOR)
}

function targetMatches(target: EventTarget | null, selector: string): boolean {
  return eventTargetElement(target)?.closest(selector) != null
}

function eventTargetElement(target: EventTarget | null): Element | null {
  if (!target || typeof target !== 'object') {
    return null
  }
  const candidate = target as {
    nodeType?: number
    parentElement?: Element | null
    closest?: (selector: string) => Element | null
  }
  if (typeof candidate.closest === 'function') {
    return candidate as Element
  }
  return candidate.parentElement ?? null
}
