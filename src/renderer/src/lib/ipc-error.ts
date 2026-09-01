/**
 * Electron's ipcRenderer.invoke wraps errors as:
 *   "Error invoking remote method 'channel': Error: actual message"
 * Strip the wrapper so users see only the meaningful part.
 */

// Why: the renderer builds this from the main side's `error.toString()`, so a handler that
// threw a message-less error arrives as a bare class name ("…': Error") — the tail can be
// empty even though the envelope is present. Global because a caller may have prefixed it.
const IPC_INVOKE_ENVELOPE = /Error invoking remote method '[^']*'(?::[ \t]*(?:\w*Error:[ \t]*)?)?/g
const BARE_ERROR_CLASS_RESIDUE = /^\w*Error:?$/

/**
 * The failure behind the IPC envelope, or null when the envelope carried no readable reason.
 * Callers that must never render plumbing branch on null instead of falling back to the
 * wrapper text — which is what `extractIpcErrorMessage` does.
 */
export function stripIpcInvokeEnvelope(message: string): string | null {
  const stripped = message.replace(IPC_INVOKE_ENVELOPE, '').trim()
  if (stripped === '' || BARE_ERROR_CLASS_RESIDUE.test(stripped)) {
    return null
  }
  return stripped
}

export function extractIpcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) {
    return fallback
  }
  const match = err.message.match(/Error invoking remote method '[^']*': (?:Error: )?(.+)/)
  return match ? match[1] : err.message
}
