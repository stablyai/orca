const PEEK_SCROLL_STEP = 28

// Focus stays on the trigger (blur closes the peek), so its keys page through the portaled list.
export function peekScrollTarget(list: HTMLUListElement, key: string): number | undefined {
  switch (key) {
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
