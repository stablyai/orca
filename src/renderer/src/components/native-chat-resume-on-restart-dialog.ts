/** Who asked: the launch read raises it by itself and takes a turn; the user opens it at once. */
export type NativeChatResumeDialogOrigin = 'launch' | 'user'

/** The offer's one dialog entry, whoever asked: the user asking takes over a queued launch offer. */
export const NATIVE_CHAT_RESUME_DIALOG_TOKEN = 'native-chat-resume'

let pendingOpen: NativeChatResumeDialogOrigin | null = null
let userAsked = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

// Why: the launch load and the status-bar entry both open this dialog, and either can fire before
// it subscribes. Keeping the request as an external snapshot prevents mount ordering from losing it.
export function requestNativeChatResumeOnRestartDialog(origin: NativeChatResumeDialogOrigin): void {
  // The user already has the offer in hand, so the launch's own ask would repeat it.
  if (origin === 'launch' && userAsked) {
    return
  }
  userAsked ||= origin === 'user'
  // A user's request is never demoted to a scheduled one.
  const next = pendingOpen === 'user' ? 'user' : origin
  if (pendingOpen === next) {
    return
  }
  pendingOpen = next
  notify()
}

export function consumeNativeChatResumeOnRestartDialogRequest(): void {
  if (pendingOpen === null) {
    return
  }
  pendingOpen = null
  notify()
}

export function getNativeChatResumeOnRestartDialogRequest(): NativeChatResumeDialogOrigin | null {
  return pendingOpen
}

export function subscribeNativeChatResumeOnRestartDialog(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** @internal - tests need a clean module between cases. */
export function _resetNativeChatResumeOnRestartDialog(): void {
  pendingOpen = null
  userAsked = false
}
