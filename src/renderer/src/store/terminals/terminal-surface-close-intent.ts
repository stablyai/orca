import type { TerminalSurfaceCloseTarget } from '../../../../shared/terminal-surface-close-target'

/** Commits a terminal tab or split-pane close in main, which owns membership: a renderer save
 *  cannot shrink it, so without this the close would ride on the PTY exit. */
export function commitTerminalSurfaceClose(
  worktreeId: string,
  target: TerminalSurfaceCloseTarget
): void {
  // Why optional: an older preload can linger through an in-place renderer reload.
  void globalThis.window?.api?.session
    ?.closeTerminalSurface?.({ worktreeId, target })
    ?.catch((error: unknown) => {
      console.warn('[terminal-close] main did not commit the close', error)
    })
}
