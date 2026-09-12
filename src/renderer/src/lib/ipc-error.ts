/**
 * Electron's ipcRenderer.invoke wraps errors as:
 *   "Error invoking remote method 'channel': Error: actual message"
 * Strip the wrapper so users see only the meaningful part.
 */
export function extractIpcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) {
    return fallback
  }
  const match = err.message.match(/Error invoking remote method '[^']*': (?:Error: )?(.+)/)
  return match ? match[1] : err.message
}

const IPC_INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*/
const ERROR_CLASS_PREFIX = /^(?:[A-Za-z_$][\w$]*)?Error:\s*/

/**
 * The same unwrapping for an already-stringified message, differing from `extractIpcErrorMessage`
 * in two ways it needs for a worktree-removal failure (#19334): it keeps everything after the
 * first line, because a failed hook's own output is the useful part, and it drops a custom error
 * class name rather than only a literal `Error:`.
 *
 * The class-name strip only applies once a wrapper was actually removed, so a renderer-local
 * `TypeError: …` keeps its prefix.
 */
export function readableIpcErrorMessage(message: string): string {
  const withoutChannel = message.replace(IPC_INVOKE_PREFIX, '')
  return withoutChannel === message ? message : withoutChannel.replace(ERROR_CLASS_PREFIX, '')
}
