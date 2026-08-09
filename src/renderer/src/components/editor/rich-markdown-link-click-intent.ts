type RichMarkdownLinkClickModifiers = Pick<
  MouseEvent,
  'button' | 'ctrlKey' | 'metaKey' | 'shiftKey'
>

export type RichMarkdownLinkClickIntent = 'select' | 'activate' | 'open-in-client-os'

export function isRichMarkdownLinkOpenModifier(
  event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>,
  isMac: boolean
): boolean {
  return isMac ? event.metaKey : event.ctrlKey
}

export function getRichMarkdownLinkClickIntent(
  event: RichMarkdownLinkClickModifiers,
  isMac: boolean,
  followLinksOnClick: boolean
): RichMarkdownLinkClickIntent {
  const modifierHeld = isRichMarkdownLinkOpenModifier(event, isMac)
  if (modifierHeld && event.shiftKey) {
    return 'open-in-client-os'
  }
  return modifierHeld || (followLinksOnClick && event.button === 0) ? 'activate' : 'select'
}
