export type ShutdownBufferCaptureOptions = {
  includeLocalBuffers?: boolean
}

/** Map of tabId → buffer-capture callback, one per mounted TerminalPane.
 *  The beforeunload handler in App.tsx invokes every callback to populate
 *  Zustand with serialized buffers before flushing the session to disk.
 *  Sleep (shutdownWorktreeTerminals with keepIdentifiers: true) iterates
 *  only the entries whose tabId belongs to the worktree being slept, so
 *  SSH worktrees can capture scrollback before the relay SIGKILLs the
 *  remote PTY — see DESIGN_DOC_TERMINAL_HISTORY_FIX_V2.md §3.3.c.
 *
 *  Why this lives in its own module: the registry is shared between
 *  TerminalPane.tsx (registration site) and the terminals store slice
 *  (sleep-time iteration). Importing it directly from TerminalPane would
 *  create a cycle (slice → TerminalPane → store → slice) that breaks the
 *  Zustand store at module-init time. A leaf module with zero imports
 *  has no cycle. */
export const shutdownBufferCaptures = new Map<
  string,
  (options?: ShutdownBufferCaptureOptions) => void
>()
