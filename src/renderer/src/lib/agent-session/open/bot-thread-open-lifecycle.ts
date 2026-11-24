import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

type ThreadChat = { executionHostId: ExecutionHostId; worktreeId: string; sessionId: string }

let pending:
  | { key: string; controller: AbortController; result: Promise<void>; chat?: ThreadChat }
  | undefined

/** A newer navigation in this window takes precedence over a pending external bot thread link. */
export function cancelPendingBotThreadOpen(): void {
  const previous = pending
  pending = undefined
  previous?.controller.abort()
}

export function bindPendingBotThreadChat(signal: AbortSignal, chat: ThreadChat): void {
  if (pending?.controller.signal === signal) {
    pending.chat = chat
  }
}

export function cancelPendingBotThreadChatClose(chat: ThreadChat): void {
  if (
    pending?.chat?.executionHostId === chat.executionHostId &&
    pending.chat.worktreeId === chat.worktreeId &&
    pending.chat.sessionId === chat.sessionId
  ) {
    cancelPendingBotThreadOpen()
  }
}

export function runBotThreadOpen(
  key: string,
  open: (signal: AbortSignal) => Promise<void>
): Promise<void> {
  if (pending?.key === key) {
    return pending.result
  }
  cancelPendingBotThreadOpen()
  const controller = new AbortController()
  const result = open(controller.signal).finally(() => {
    if (pending?.controller === controller) {
      pending = undefined
    }
  })
  pending = { key, controller, result }
  return result
}
