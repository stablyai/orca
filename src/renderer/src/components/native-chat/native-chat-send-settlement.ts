import { waitForNativeChatPtyIdle } from './native-chat-pty-send-queue'
import type { NativeChatSendHandle } from './native-chat-send-handle'

export function waitForNativeChatSendQueueIdle(
  ptyId: string,
  settled?: Promise<void>
): Promise<void> | undefined {
  return settled?.then(
    () => waitForNativeChatPtyIdle(ptyId),
    () => waitForNativeChatPtyIdle(ptyId)
  )
}

export function trackNativeSend<THandle>(
  handle: THandle | null,
  track: (handle: THandle, pendingId?: string) => void,
  pendingId?: string
): void {
  if (handle) {
    track(handle, pendingId)
  }
}

export function reportNativeChatCommand(
  onSlashCommand:
    | ((command: string, settled?: Promise<void>, cancelled?: () => boolean) => void)
    | undefined,
  command: string,
  ptyId: string,
  handle: NativeChatSendHandle | null
): void {
  const settled = waitForNativeChatSendQueueIdle(ptyId, handle?.settled)
  if (handle?.cancelled) {
    onSlashCommand?.(command, settled, handle.cancelled)
  } else {
    onSlashCommand?.(command, settled)
  }
}
