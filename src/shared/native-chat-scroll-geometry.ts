export const NATIVE_CHAT_BOTTOM_THRESHOLD_PX = 48

export function nativeChatDistanceFromBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number
): number {
  return Math.max(0, scrollHeight - clientHeight - scrollTop)
}

export function isNativeChatNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = NATIVE_CHAT_BOTTOM_THRESHOLD_PX
): boolean {
  return nativeChatDistanceFromBottom(scrollTop, scrollHeight, clientHeight) <= threshold
}

export function shouldShowNativeChatJumpToLatest(
  isStuckToBottom: boolean,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = NATIVE_CHAT_BOTTOM_THRESHOLD_PX
): boolean {
  return (
    !isStuckToBottom &&
    nativeChatDistanceFromBottom(scrollTop, scrollHeight, clientHeight) > threshold
  )
}
