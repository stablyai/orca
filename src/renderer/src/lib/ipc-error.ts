/**
 * Renderer-side entry point for reading a rejected `ipcMain.handle`.
 *
 * The envelope itself is described once in `shared` because main-side callers strip it too.
 * Nothing here knows the wire format.
 */

import { stripIpcInvokeEnvelope } from '../../../shared/ipc-invoke-envelope'

export {
  stripErrorClassPrefix,
  stripIpcInvokeEnvelope,
  stripIpcInvokeEnvelopeFrom
} from '../../../shared/ipc-invoke-envelope'

/**
 * The reason behind an IPC rejection, or `fallback` when the rejection carried none.
 *
 * Callers pass copy that already names what they were doing, so an envelope with nothing behind
 * it renders that sentence rather than the plumbing. Falling back logs the rejection first: the
 * copy is what the user reads, not a record of what failed.
 */
export function extractIpcErrorMessage(err: unknown, fallback: string): string {
  const reason = err instanceof Error ? stripIpcInvokeEnvelope(err.message) : null
  if (reason === null) {
    console.warn('[ipc] rejection carried no readable reason; showing fallback copy', err)
    return fallback
  }
  return reason
}
