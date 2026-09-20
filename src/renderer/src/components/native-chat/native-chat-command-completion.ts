import type { NativeChatSendHandle } from './native-chat-runtime-send'

/** A picker may unmount the composer; finish sending before opening it. */
export function afterNativeChatCommandSent(
  handle: NativeChatSendHandle,
  onSent: () => void
): NativeChatSendHandle {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const completed = (): void => {
    if (!cancelled) {
      onSent()
    }
  }
  if (handle.settled) {
    void handle.settled.then(completed, () => {})
  } else {
    timer = setTimeout(completed, handle.settleAfterMs)
  }
  return {
    ...handle,
    cancel: () => {
      cancelled = true
      clearTimeout(timer)
      handle.cancel()
    }
  }
}
