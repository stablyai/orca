export const GRAB_NATIVE_KEY_POLICY = 'browser:grab-native-key-policy'
export const GRAB_NATIVE_KEY_REPORT = 'browser:grab-native-key-report'
export const GRAB_CHORD_POLICY = 'browser:grab-chord-policy'
export const GRAB_CHORD_REPORT = 'browser:grab-chord-report'
export type GrabChordPolicy = {
  token: string
  revision: number
  enabled: boolean
  bindings: string[]
  platform: NodeJS.Platform
}

export type GrabNativeKeyPolicy = {
  token: string
  revision: number
  enabled: boolean
  paletteKeys?: boolean
}

export function guestFocusTakesTyping(): boolean {
  let element = document.activeElement
  while (element?.shadowRoot?.activeElement) {
    element = element.shadowRoot.activeElement
  }
  if (!element) {
    return false
  }
  const tag = element.tagName
  if (element instanceof HTMLElement && element.isContentEditable) {
    return true
  }
  if (/^(TEXTAREA|SELECT|IFRAME|FRAME|OBJECT|EMBED)$/.test(tag)) {
    return true
  }
  if (element instanceof HTMLInputElement) {
    return ![
      'button',
      'checkbox',
      'radio',
      'submit',
      'reset',
      'image',
      'file',
      'color',
      'range',
      'hidden'
    ].includes(element.type)
  }
  const canHideRoot =
    tag.includes('-') ||
    /^(ARTICLE|ASIDE|BLOCKQUOTE|BODY|DIV|FOOTER|H[1-6]|HEADER|MAIN|NAV|P|SECTION|SPAN)$/.test(tag)
  return canHideRoot && !element.shadowRoot && (tag !== 'BODY' || element.matches(':focus-within'))
}
