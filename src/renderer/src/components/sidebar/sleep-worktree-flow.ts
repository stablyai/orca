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
  await runSleepWorktrees([worktreeId])
}

function suppressActiveSleepPtyExitActivity(worktreeId: string): string[] {
  const { ptyIdsByTabId, suppressPtyExit, tabsByWorktree } = useAppStore.getState()
  const ptyIds: string[] = []
  for (const tab of tabsByWorktree[worktreeId] ?? []) {
    for (const ptyId of ptyIdsByTabId[tab.id] ?? []) {
      ptyIds.push(ptyId)
      suppressPtyExit(ptyId)
    }
  }
  return ptyIds
}

function releaseActiveSleepPtyExitSuppressions(ptyIds: readonly string[]): void {
  const { consumeSuppressedPtyExit } = useAppStore.getState()
  for (const ptyId of ptyIds) {
    consumeSuppressedPtyExit(ptyId)
  }
}

export async function runSleepWorktrees(worktreeIds: readonly string[]): Promise<void> {
  if (worktreeIds.length === 0) {
    return
  }
  const {
    activeWorktreeId,
    setActiveWorktree,
    shutdownWorktreeBrowsers,
    shutdownWorktreeTerminals
  } = useAppStore.getState()
  let preSuppressedActivePtyIds: string[] = []
  if (activeWorktreeId && worktreeIds.includes(activeWorktreeId)) {
    // Why: clearing the active workspace unmounts its TerminalPanes before
    // shutdownWorktreeTerminals can mark exits as intentional. Pre-suppress
    // those PTYs so the unmount does not stamp lastActivityAt and reorder the
    // slept card to the top.
    preSuppressedActivePtyIds = suppressActiveSleepPtyExitActivity(activeWorktreeId)
    setActiveWorktree(null)
  }
  const errors: string[] = []
  for (const worktreeId of worktreeIds) {
    try {
      // Why: sleep mirrors removeWorktree's shutdown sequence — browsers first
      // so destroyPersistentWebview unregisters the Chromium guests before any
      // other teardown runs, terminals second so the PTY kill uses the same
      // ordering on both paths. Without the browser thunk here, sleep leaks
      // browserPagesByWorkspace entries and live webviews for the slept worktree.
      await shutdownWorktreeBrowsers(worktreeId)
    } catch (err) {
      if (worktreeId === activeWorktreeId) {
        releaseActiveSleepPtyExitSuppressions(preSuppressedActivePtyIds)
      }
      errors.push(err instanceof Error ? err.message : String(err))
      continue
    }
    try {
      // Why: sleep is reversible — the tab record stays in tabsByWorktree, the
      // layout stays in terminalLayoutsByTabId, only the live PTY processes are
      // released. keepIdentifiers preserves tab.ptyId / ptyIdsByLeafId /
      // lastKnownRelayPtyIdByTabId so wake re-spawns against the same on-disk
      // history dir (local) or relay session id (SSH); it also captures
      // serializer buffers into buffersByLeafId for SSH wake to reseed
      // scrollback. See DESIGN_DOC_TERMINAL_HISTORY_FIX_V2.md §3.3.c.
      await shutdownWorktreeTerminals(worktreeId, { keepIdentifiers: true })
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  if (errors.length > 0) {
    // Why: callers are fire-and-forget; surface the failure as a toast and
    // otherwise continue — the active-worktree reset already happened so we
    // don't leave the UI in a stale state.
    toast.error(
      worktreeIds.length === 1 ? 'Failed to sleep workspace' : 'Failed to sleep some workspaces',
      {
        description: errors.join('\n')
      }
    )
  }
}
