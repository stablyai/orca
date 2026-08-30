import { translate } from '@/i18n/i18n'
import { stripIpcInvokeEnvelope } from '@/lib/ipc-error'

// Why: the error surface aggregates every pane error into ONE newline-joined
// string so TerminalErrorToast's per-line filters (isSshReconnectOwnedTerminalError,
// stripSshReconnectOwnedErrorLines) keep working. That join makes line-based
// dedup wrong for messages that themselves contain newlines: a multi-line
// message is never one line of the accumulated value, so it would re-append on
// every recurrence and grow without bound.
function containsWholeLineRun(accumulated: string, message: string): boolean {
  return (
    accumulated === message ||
    accumulated.startsWith(`${message}\n`) ||
    accumulated.endsWith(`\n${message}`) ||
    accumulated.includes(`\n${message}\n`)
  )
}

/**
 * The reason a pane error carries, with Electron's IPC envelope removed.
 *
 * Several producers hand this surface `err.message` straight off a rejected `ipcRenderer.invoke`
 * (retained-legacy attach, both deferred-reattach paths, deferred attach), so the envelope reaches
 * the toast even though every direct `extractIpcErrorMessage` call site is already clean. Stripping
 * at the accumulator rather than at each producer is what makes the guarantee hold for a producer
 * nobody has written yet — the value cannot reach the toast without passing through here.
 *
 * An envelope with nothing behind it (a message-less rejection arrives as a bare class name) has no
 * reason to show, so it renders copy that says so rather than the plumbing. The raw form is logged
 * by the caller, which is outside React's state updater.
 */
function readableTerminalErrorMessage(message: string): string {
  return (
    stripIpcInvokeEnvelope(message) ??
    translate(
      'auto.components.terminal.pane.terminalErrorAccumulation.unreadableTerminalError',
      'The terminal reported a failure, and it did not include a readable reason.'
    )
  )
}

/** Appends an error to the aggregated surface, keeping the first occurrence of an already-present message. */
export function appendTerminalErrorMessage(accumulated: string | null, message: string): string {
  const readable = readableTerminalErrorMessage(message)
  if (!accumulated) {
    return readable
  }
  return containsWholeLineRun(accumulated, readable) ? accumulated : `${accumulated}\n${readable}`
}
