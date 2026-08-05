export type NativeChatPrependAnchor = {
  row: HTMLElement | null
  rowTop: number
  scrollHeight: number
  scrollTop: number
}

export function captureNativeChatPrependAnchor(
  scroller: HTMLElement,
  content: HTMLElement | null
): NativeChatPrependAnchor {
  const scrollerRect = scroller.getBoundingClientRect()
  const rows = content?.querySelectorAll<HTMLElement>('[data-native-chat-message-id]') ?? []
  const row = Array.from(rows).find((candidate) => {
    const rect = candidate.getBoundingClientRect()
    return rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom
  })
  return {
    row: row ?? null,
    rowTop: row?.getBoundingClientRect().top ?? 0,
    scrollHeight: scroller.scrollHeight,
    scrollTop: scroller.scrollTop
  }
}

export function restoreNativeChatPrependAnchor(
  scroller: HTMLElement,
  anchor: NativeChatPrependAnchor
): void {
  const growth = anchor.row?.isConnected
    ? anchor.row.getBoundingClientRect().top - anchor.rowTop
    : scroller.scrollHeight - anchor.scrollHeight
  scroller.scrollTop = anchor.scrollTop + growth
}
