import type { RestartMachineKey } from './native-chat-restart-machines'

/** An open request, and the machine it was opened for (that machine's row starts expanded). */
export type NativeChatResumeOnRestartDialogRequest = Readonly<{
  focus: RestartMachineKey | null
}>

let pending: NativeChatResumeOnRestartDialogRequest | null = null
/** How many resume dialogs are mounted to draw a request (the app mounts one). */
let mountedDialogs = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

// Why: the launch load, the status-bar entry and a reconnect toast all open this dialog, and any
// can fire before it subscribes. Keeping the request as an external snapshot prevents mount
// ordering from losing it.
export function requestNativeChatResumeOnRestartDialog(
  focus: RestartMachineKey | null = null
): void {
  // An open dialog stays as it is: a later request (this computer's launch read landing under it)
  // would move its focus and reset the user's ticks, and the dialog lists every machine anyway.
  if (pending) {
    return
  }
  pending = { focus }
  notify()
}

export function consumeNativeChatResumeOnRestartDialogRequest(): void {
  if (!pending) {
    return
  }
  pending = null
  notify()
}

export function getNativeChatResumeOnRestartDialogRequest(): NativeChatResumeOnRestartDialogRequest | null {
  return pending
}

/** The dialog's own mount; returns its unmount. */
export function mountNativeChatResumeDialog(): () => void {
  mountedDialogs += 1
  return () => {
    mountedDialogs -= 1
  }
}

/** Whether a mounted dialog would draw a request right now, given whether any machine lists rows.
 *  Read at the moment of asking, from the state the dialog renders from: never a copy of it. */
export function nativeChatResumeDialogOnScreen(rowsListed: boolean): boolean {
  return pending !== null && rowsListed && mountedDialogs > 0
}

export function subscribeNativeChatResumeOnRestartDialog(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** @internal - tests need a clean module between cases. */
export function _resetNativeChatResumeOnRestartDialog(): void {
  pending = null
}
