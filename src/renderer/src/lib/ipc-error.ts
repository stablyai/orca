// Why: Electron re-wraps a rejected `ipcMain.handle` as
// `Error invoking remote method '<channel>': Error: <message>`, so the main-process sentence is
// buried behind transport noise by the time a toast or an inline error shows it.
// Why unanchored: a caller can compose its own prefix around an already-wrapped message — e.g.
// `SSH connection failed: ${connectResult.error}` (`pty-connection/deferred-session-attach.ts`),
// pinned by `TerminalErrorToast.test.ts`. Anchoring would leave that transport noise on screen.
const IPC_INVOKE_PREFIX = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?/
const IPC_HANDLER_PREFIX = /Error occurred in handler for '[^']*':\s*(?:Error:\s*)?/

/**
 * Unwrapped but unclamped — for a slot that can render more than one line, such as a persistent
 * inline error band. Git and SSH stderr routinely carry the useful part on lines 2+.
 */
export function readIpcErrorDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined
  }
  const message = error.message
    .replace(IPC_INVOKE_PREFIX, '')
    .replace(IPC_HANDLER_PREFIX, '')
    .trim()
  return message || undefined
}

/**
 * Unwrapped and clamped to one line — for a toast, whose title is a single emphasised row and whose
 * description is a compact one. Multi-line stderr would balloon a transient surface.
 */
export function readIpcErrorMessage(error: unknown): string | undefined {
  return readIpcErrorDetail(error)?.split('\n')[0]?.trim() || undefined
}

/**
 * Same, for callers that must render something even when the error carries no message.
 *
 * Why the branch: `main`'s regex clamped only the WRAPPED case — `(.+)` has no `s` flag, so it
 * stopped at the first newline — while an unwrapped message fell through to `err.message` and was
 * returned whole. Nine of these callers render the result as a sonner title, but six feed inline
 * error bands (`useAddRepoCloneFlow`, `AddRepoSteps`, `useCreateRepo`, `McpConfigSection`,
 * `mcp-config-inspection`, `use-native-chat-composer-paste`) where clamping would drop lines 2+.
 * Matching `main` on both branches keeps both groups right.
 *
 * Deliberate divergences from `main`, all narrow:
 * - a composed message keeps its caller's own prefix: `main`'s regex discarded everything before the
 *   wrapper, so `SSH connection failed: <wrapped>` lost the first half; the wrapper is now stripped
 *   in place, leaving `SSH connection failed: <message>`;
 * - a blank or wrapper-only message yields the fallback rather than an empty or junk title;
 * - the handler prefix, which `main` did not recognise at all, is stripped and therefore clamped —
 *   the right trade for the nine toast-title files, at the cost of a BARE handler-prefixed
 *   multi-line error showing one line in an inline band. No producer of that shape exists today.
 *
 * One caller is neither a title nor an inline band: `terminal-pane/ipc-pty-connect.ts` feeds the
 * result to `isSshSessionGoneError` and `.includes()` marker checks, i.e. control flow. Tightening
 * the clamp would silently break SSH session-expiry detection there.
 */
export function extractIpcErrorMessage(err: unknown, fallback: string): string {
  const detail = readIpcErrorDetail(err)
  if (!detail) {
    return fallback
  }
  const wrapped =
    err instanceof Error &&
    (IPC_INVOKE_PREFIX.test(err.message) || IPC_HANDLER_PREFIX.test(err.message))
  return wrapped ? detail.split('\n')[0]?.trim() || fallback : detail
}
