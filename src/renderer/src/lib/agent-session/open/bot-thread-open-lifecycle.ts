import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

type ThreadChat = { executionHostId: ExecutionHostId; worktreeId: string; sessionId: string }

let pending:
  | {
      key: string
      controller: AbortController
      result: Promise<void>
      chat?: ThreadChat
      currentHost?: () => boolean
      hoveredPane?: { tabId: string; leafId: string }
      focusingByHover?: boolean
    }
  | undefined

/** A newer navigation in this window takes precedence over a pending external bot thread link. */
export function cancelPendingBotThreadOpen(): void {
  const previous = pending
  pending = undefined
  previous?.controller.abort()
}

let started = 0

/** How many external bot thread links began opening in this window. It only grows, so an older open
 *  still sees a newer link after that link settled or was cancelled by its own navigation. */
export function botThreadOpenRevision(): number {
  return started
}

export function noteBotThreadPaneActivation(
  tabId: string,
  leafId: string,
  interaction: 'user' | 'hover' | undefined,
  changed: boolean
): void {
  if (!pending) {
    return
  }
  const hovered = pending.hoveredPane
  // Clicking a pane just focused by hover confirms the user's destination.
  if (
    interaction === 'user' &&
    (changed || (hovered?.tabId === tabId && hovered.leafId === leafId))
  ) {
    cancelPendingBotThreadOpen()
  } else if (interaction === 'hover') {
    pending.hoveredPane = { tabId, leafId }
  } else if (changed && hovered?.tabId === tabId) {
    pending.hoveredPane = undefined
  }
}

export function withBotThreadPaneHover(focus: () => void): void {
  const open = pending
  if (!open || open.focusingByHover) {
    focus()
    return
  }
  open.focusingByHover = true
  try {
    focus()
  } finally {
    open.focusingByHover = false
  }
}

export function botThreadPaneHoverIsFocusing(): boolean {
  return pending?.focusingByHover === true
}

export function bindPendingBotThreadChat(signal: AbortSignal, chat: ThreadChat): void {
  if (pending?.controller.signal === signal) {
    pending.chat = chat
  }
}

export function bindPendingBotThreadHost(signal: AbortSignal, currentHost: () => boolean): void {
  if (pending?.controller.signal === signal) {
    pending.currentHost = currentHost
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
  if (pending?.key === key && pending.currentHost?.() !== false) {
    return pending.result
  }
  cancelPendingBotThreadOpen()
  started += 1
  const controller = new AbortController()
  const result = open(controller.signal).finally(() => {
    if (pending?.controller === controller) {
      pending = undefined
    }
  })
  pending = { key, controller, result }
  return result
}
