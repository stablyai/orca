import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { useAllWorktrees, useRepoMap } from '@/store/selectors'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/types'
import {
  resolveChecksPanelTerminalPtyId,
  resolveChecksPanelWorktreeFromTerminalCwd
} from './checks-panel-terminal-worktree'

// Why poll past the main-side cache: getCwd coalesces and caches per-pid for
// 1.5s, and on macOS a cache miss shells out to `lsof`. Polling slower than
// that TTL keeps this from spawning a subprocess on every tick while still
// noticing a plain `cd`.
const TERMINAL_CWD_POLL_MS = 4000

type ChecksPanelTerminalWorktree = {
  /** Worktree the active terminal is operating in, or the caller's fallback. */
  worktree: Worktree | null
}

/**
 * Resolve the worktree the active terminal is working in so the Checks panel
 * can follow the terminal's cwd across a stack of worktrees.
 *
 * Reads the cwd authoritatively from the local PTY's process (getCwd) rather
 * than the shell-reported OSC 7 cwd: a local terminal running `ssh`/tmux emits
 * the *remote* shell's OSC 7 path, which must not resolve a local worktree.
 * getCwd reads the local shell pid, so it is correct for that case. Remote
 * runtime PTYs are skipped (their cwd lives on the relay host). Polling is
 * gated on both panel visibility and window visibility, so a hidden panel or a
 * hidden/minimized window does no background work (no `lsof` spawns) and the
 * caller's fallback worktree is used.
 *
 * Resolution is scoped to locally-executing worktrees: the cwd comes from a
 * local PTY, and worktree paths are not unique across hosts (an SSH worktree
 * can share `/home/me/project` with a local one), so matching across hosts
 * could surface the wrong host's linked PR.
 */
export function useChecksPanelTerminalWorktree(args: {
  defaultActiveWorktree: Worktree | null
  isPanelVisible: boolean
}): ChecksPanelTerminalWorktree {
  const { defaultActiveWorktree, isPanelVisible } = args
  const allWorktrees = useAllWorktrees()
  const repoMap = useRepoMap()
  const localWorktrees = useMemo(
    () =>
      allWorktrees.filter((worktree) => {
        // Why hostId first: a worktree can override its repo's execution host
        // (e.g. a local-host worktree under a runtime repo). Mirrors the
        // resolution in worktree-parent-candidates.ts.
        const repo = repoMap.get(worktree.repoId)
        const hostId = worktree.hostId ?? (repo ? getRepoExecutionHostId(repo) : null)
        return hostId === LOCAL_EXECUTION_HOST_ID
      }),
    [allWorktrees, repoMap]
  )

  const activeTerminalPtyId = useAppStore(
    useShallow((s) =>
      resolveChecksPanelTerminalPtyId({
        activeTabId: s.activeTabId,
        ptyIdsByTabId: s.ptyIdsByTabId,
        terminalLayoutsByTabId: s.terminalLayoutsByTabId
      })
    )
  )

  // Only poll local PTYs. Remote-runtime (`remote:`) and SSH (`ssh:`) PTYs
  // report a cwd on their relay host, which must not resolve a local worktree.
  const isLocalTerminalPty =
    activeTerminalPtyId !== null &&
    !isRemoteRuntimePtyId(activeTerminalPtyId) &&
    parseAppSshPtyId(activeTerminalPtyId) === null
  const shouldPollCwd = isPanelVisible && isLocalTerminalPty

  const [polledCwd, setPolledCwd] = useState<{ ptyId: string; cwd: string | null } | null>(null)

  useEffect(() => {
    if (!shouldPollCwd || activeTerminalPtyId === null) {
      setPolledCwd(null)
      return
    }

    let disposed = false
    const commit = (cwd: string | null): void => {
      if (disposed) {
        return
      }
      // Keep the prior state object when nothing changed so an unchanged cwd
      // doesn't re-render the (large) Checks panel every poll tick.
      setPolledCwd((prev) =>
        prev?.ptyId === activeTerminalPtyId && prev.cwd === cwd
          ? prev
          : { ptyId: activeTerminalPtyId, cwd }
      )
    }
    // Retain the last good cwd through transient empty/error polls; clearing
    // here re-keys the Checks panel and wipes mid-edit state.
    const retainResolvedOrClear = (): void => {
      if (disposed) {
        return
      }
      setPolledCwd((prev) =>
        prev?.ptyId === activeTerminalPtyId && prev.cwd !== null
          ? prev
          : { ptyId: activeTerminalPtyId, cwd: null }
      )
    }
    const refresh = async (): Promise<void> => {
      try {
        const cwd = (await window.api.pty.getCwd(activeTerminalPtyId)).trim()
        if (cwd) {
          commit(cwd)
        } else {
          retainResolvedOrClear()
        }
      } catch {
        retainResolvedOrClear()
      }
    }

    // Why: getCwd shells out to `lsof` on macOS every tick (poll cadence >
    // the 1.5s per-pid cache TTL, so each tick is a guaranteed miss). Gate on
    // window visibility so a hidden/minimized window spawns no subprocesses;
    // the helper runs an immediate refresh on becoming visible so a `cd` made
    // while hidden is picked up promptly on return.
    const stopInterval = installWindowVisibilityInterval({
      run: () => void refresh(),
      intervalMs: TERMINAL_CWD_POLL_MS
    })
    return () => {
      disposed = true
      stopInterval()
    }
  }, [activeTerminalPtyId, shouldPollCwd])

  // Ignore a stale result captured for a previously-active PTY.
  const terminalCwd = polledCwd?.ptyId === activeTerminalPtyId ? polledCwd.cwd : null

  const terminalCwdWorktree = useMemo(
    () => resolveChecksPanelWorktreeFromTerminalCwd(terminalCwd, localWorktrees),
    [localWorktrees, terminalCwd]
  )

  // Fall back to the sidebar's active worktree (never blank) while the terminal
  // cwd is still resolving or maps to no known worktree.
  return { worktree: terminalCwdWorktree ?? defaultActiveWorktree }
}
