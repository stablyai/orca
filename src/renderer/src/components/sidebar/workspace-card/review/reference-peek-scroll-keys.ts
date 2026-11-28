const PEEK_SCROLL_STEP = 28

type PeekScrollList = Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>
type PeekScrollKey = Pick<
  KeyboardEvent,
  'key' | 'defaultPrevented' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>

// Focus stays on the trigger (blur closes the peek), so its keys page through the portaled list.
export function peekScrollTarget(list: PeekScrollList, event: PeekScrollKey): number | undefined {
  // Why: chords like Ctrl+End belong to app shortcuts; a handled key must not also scroll.
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return undefined
  }
  switch (event.key) {
    case 'ArrowDown':
      return list.scrollTop + PEEK_SCROLL_STEP
    case 'ArrowUp':
      return list.scrollTop - PEEK_SCROLL_STEP
    case 'PageDown':
      return list.scrollTop + list.clientHeight
    case 'PageUp':
      return list.scrollTop - list.clientHeight
    case 'Home':
      return 0
    case 'End':
      return list.scrollHeight
    default:
      return undefined
  }
}
