import { toast } from 'sonner'
import { useAppStore } from '@/store'

/**
 * Shared "sleep worktree" flow (close all panels to free memory / CPU)
 * used by WorktreeContextMenu and MemoryStatusSegment's per-row hover action.
 *
 * Why this is a module helper rather than inlined at each call site: the guard
 * that clears `activeWorktreeId` before tearing down terminals isn't optional
 * polish — shutting down the active worktree while its TerminalPane is still
 * visible causes a visible "reboot" flicker and can crash the pane (PTY exit
 * callbacks race against the live xterm instance). See the original comment
 * in WorktreeContextMenu's handleCloseTerminals for the full reasoning.
 * Centralizing the sequence here keeps that safety invariant in one place so
 * a new caller can't accidentally skip it.
 */
export async function runSleepWorktree(worktreeId: string): Promise<void> {
  const {
    activeWorktreeId,
    setActiveWorktree,
    shutdownWorktreeBrowsers,
    shutdownWorktreeTerminals
  } = useAppStore.getState()
  if (activeWorktreeId === worktreeId) {
    setActiveWorktree(null)
  }
  try {
    // Why: sleep mirrors removeWorktree's shutdown sequence — browsers first
    // so destroyPersistentWebview unregisters the Chromium guests before any
    // other teardown runs, terminals second so the PTY kill uses the same
    // ordering on both paths. Without the browser thunk here, sleep leaks
    // browserPagesByWorkspace entries and live webviews for the slept worktree.
    await shutdownWorktreeBrowsers(worktreeId)
    await shutdownWorktreeTerminals(worktreeId)
  } catch (err) {
    // Why: callers are fire-and-forget; surface the failure as a toast and
    // otherwise continue — the active-worktree reset already happened so we
    // don't leave the UI in a stale state.
    toast.error('Failed to sleep workspace', {
      description: err instanceof Error ? err.message : String(err)
    })
  }
}
