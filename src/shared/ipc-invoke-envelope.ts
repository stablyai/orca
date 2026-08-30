/**
 * Electron names a rejected `ipcMain.handle` twice, and neither name is product copy.
 *
 * The renderer rethrows as "Error invoking remote method '<channel>': <tail>", where the tail
 * is the main side's `error.toString()`. Main's own console additionally carries
 * "Error occurred in handler for '<channel>':" — see Electron's `replyWithError`. Both shapes
 * are stripped here so a message that has crossed either boundary reads the same.
 *
 * Lives in `shared` rather than the renderer because main-side callers strip the same envelope.
 */

// Why: the tail is `error.toString()`, so a handler that threw a message-less error arrives as a
// bare class name ("…': Error") — the tail can be empty even though the envelope is present.
// Global and unanchored because a caller may have prefixed the envelope with its own context.
const IPC_ENVELOPE =
  /(?:Error invoking remote method|Error occurred in handler for) '[^']*'(?::[ \t]*(?:\w*Error:[ \t]*)?)?/g
const BARE_ERROR_CLASS_RESIDUE = /^\w*Error:?$/

/**
 * The failure behind the IPC envelope, or null when the envelope carried no readable reason.
 * Callers that must never render plumbing branch on null instead of falling back to the
 * wrapper text — which is what `extractIpcErrorMessage` does.
 */
export function stripIpcInvokeEnvelope(message: string): string | null {
  const stripped = message.replace(IPC_ENVELOPE, '').trim()
  if (stripped === '' || BARE_ERROR_CLASS_RESIDUE.test(stripped)) {
    return null
  }
  return stripped
}

/**
 * `Error.prototype.toString()` renders "Error: <message>", so a rejection that was stringified
 * rather than read through `.message` arrives with a class prefix that is not part of the reason.
 * Separate from the envelope: a message can carry this prefix without ever crossing IPC.
 *
 * Case-sensitive, like the class name inside `IPC_ENVELOPE` above: V8 writes the constructor
 * name, so the prefix is always exactly `Error: `. A lowercase `error: ` is git's, rpm's and
 * pip's severity marker in front of a real reason, and trimming it would drop the word the line
 * is being read for.
 */
export function stripErrorClassPrefix(text: string): string {
  return text.replace(/^Error:[ \t]*/, '')
}

/**
 * Same contract for a caller holding an unknown rejection rather than a string. A nullish
 * rejection has no reason at all, so it takes the null branch rather than printing "undefined".
 */
export function stripIpcInvokeEnvelopeFrom(error: unknown): string | null {
  if (error === null || error === undefined) {
    return null
  }
  return stripIpcInvokeEnvelope(String((error as Error).message ?? error))
}
