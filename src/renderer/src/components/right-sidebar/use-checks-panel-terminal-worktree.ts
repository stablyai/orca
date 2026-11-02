import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { useAllWorktrees, useRepoMap } from '@/store/selectors'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  resolveChecksPanelTerminalPtyId,
  resolveChecksPanelWorktreeFromTerminalCwd
} from './checks-panel-terminal-worktree'

// Poll slower than the 1.5s per-pid cache TTL to bound macOS lsof subprocesses while noticing plain cd.
const TERMINAL_CWD_POLL_MS = 4000

type ChecksPanelTerminalWorktree = {
  /** Worktree the active terminal is operating in, or the caller's fallback. */
  worktree: Worktree | null
}

/** Resolve local PTY process cwd, never remote OSC 7 paths; match only local worktrees because paths overlap across hosts, and fall back while hidden or unresolved. */
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
        // Worktree hostId overrides repo ownership, matching worktree-parent-candidates.
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

  // Remote/SSH PTYs report host-side paths that cannot identify local worktrees.
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
      // Preserve identity for unchanged cwd to avoid rerendering the large Checks panel each poll.
      setPolledCwd((prev) =>
        prev?.ptyId === activeTerminalPtyId && prev.cwd === cwd
          ? prev
          : { ptyId: activeTerminalPtyId, cwd }
      )
    }
    // Retain good cwd through transient empty/errors so panel re-keying cannot wipe edits.
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

    // Hide lsof-backed polling with the window; visibility recovery immediately picks up cwd changes.
    const stopInterval = installWindowVisibilityInterval({
      run: () => void refresh(),
      intervalMs: TERMINAL_CWD_POLL_MS
    })
    return () => {
      disposed = true
      stopInterval()
    }
  }, [activeTerminalPtyId, shouldPollCwd])

  const terminalCwd = polledCwd?.ptyId === activeTerminalPtyId ? polledCwd.cwd : null

  const terminalCwdWorktree = useMemo(
    () => resolveChecksPanelWorktreeFromTerminalCwd(terminalCwd, localWorktrees),
    [localWorktrees, terminalCwd]
  )

  return { worktree: terminalCwdWorktree ?? defaultActiveWorktree }
}
