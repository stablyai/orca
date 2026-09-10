import { useAppStore } from '@/store'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import {
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive,
  isWebTerminalSurfaceTabId
} from '@/runtime/web-runtime-session'
import { getLastKnownHostTerminalTabCount } from '@/runtime/web-session-tabs-sync'
import {
  beginWebRuntimeWakeTerminalRespawn,
  endWebRuntimeWakeTerminalRespawn
} from '@/runtime/web-runtime-wake-terminal-respawn'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { shouldAutoCreateInitialTerminal } from '@/components/terminal/initial-terminal'

export function ensureWebRuntimeWorktreeTerminalAfterWake(worktreeId: string): void {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(worktreeId)
  if (!worktree) {
    return
  }
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktree.id)
  if (!runtimeEnvironmentId || !isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    return
  }

  const tabs = state.tabsByWorktree[worktreeId] ?? []
  const hasLivePty = tabs.some((tab) => tabHasLivePty(state.ptyIdsByTabId, tab.id))
  if (hasLivePty) {
    return
  }

  const hasMirroredHostTabs = tabs.some((tab) => isWebTerminalSurfaceTabId(tab.id))
  if (hasMirroredHostTabs) {
    // Why: the host session still owns these tabs — wait for the mirror to repopulate PTY handles instead of duplicating a terminal.
    return
  }

  if (getLastKnownHostTerminalTabCount(runtimeEnvironmentId, worktreeId) > 0) {
    return
  }

  // Why the branch split: two states used to share one line. With NO rows the workspace is being
  // seeded for the first time, and that decision belongs to the canonical predicate — an explicit
  // empty row is the closed-last-terminal tombstone, not "never initialized", and this is the only
  // door a tombstoned workspace reaches (the stream-frame path returns before it). With rows
  // present the question is instead whether a woke workspace's tab chrome outlived its PTYs, which
  // the tombstone has nothing to say about.
  const { renderableTabCount } = state.reconcileWorktreeTabModel(worktreeId)
  if (tabs.length === 0) {
    if (
      !shouldAutoCreateInitialTerminal(
        renderableTabCount,
        Object.hasOwn(state.tabsByWorktree, worktreeId)
      )
    ) {
      return
    }
  } else if (renderableTabCount === 0) {
    return
  }

  if (!beginWebRuntimeWakeTerminalRespawn(worktreeId)) {
    return
  }

  // Why: sleep keeps tab rows but terminal.stop clears host PTYs, so a woke workspace can have tab chrome but no surface.
  void createWebRuntimeSessionTerminal({
    worktreeId,
    environmentId: runtimeEnvironmentId,
    activate: true,
    selectWorktree: false
  }).finally(() => {
    endWebRuntimeWakeTerminalRespawn(worktreeId)
  })
}
