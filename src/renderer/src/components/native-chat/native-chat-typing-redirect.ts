type KeyboardRedirectEvent = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey?: boolean
  altKey?: boolean
  defaultPrevented: boolean
  isComposing?: boolean
  target: EventTarget | null
}

const INTERACTIVE_TARGET_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
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

export function shouldRedirectNativeChatTyping(event: KeyboardRedirectEvent): boolean {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.key.length !== 1
  ) {
    return false
  }
  return !isNativeChatInteractiveTarget(event.target)
}

export function shouldFocusNativeChatPaneFromPointerTarget(target: EventTarget | null): boolean {
  return !isNativeChatInteractiveTarget(target)
}

/** Unmodified Backspace/Delete pressed outside any input should focus the
 *  composer, the same way printable typing does — but unlike typing these keys
 *  are not inserted (their character has no literal form), so the caller only
 *  focuses. Modified chords (Shift/Alt/Ctrl/Cmd+Delete = cut, delete-word, …)
 *  are left to the focused target. */
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
  return !isNativeChatInteractiveTarget(event.target)
}

function isNativeChatInteractiveTarget(target: EventTarget | null): boolean {
  const element = eventTargetElement(target)
  if (!element) {
    return false
  }
  return element.closest(INTERACTIVE_TARGET_SELECTOR) !== null
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
