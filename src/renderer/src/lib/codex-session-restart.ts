import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'

function normalizeProcessName(processName: string | null): string | null {
  if (!processName) {
    return null
  }
  return processName.toLowerCase().replace(/\.exe$/, '')
}

function isCodexForegroundProcess(processName: string | null): boolean {
  const normalized = normalizeProcessName(processName)
  if (!normalized) {
    return false
  }
  // Why: node-pty exposes the OS foreground process name, which can be the
  // shipped Codex binary name (for example "codex-aarch64-ap" on macOS)
  // instead of the shell command the user typed. Match on a Codex prefix so
  // account-switch restart prompts still appear for real Codex sessions.
  return normalized === 'codex' || normalized.startsWith('codex-')
}

function tabTitleLooksLikeCodex(state: AppState, ptyId: string): boolean {
  for (const [tabId, ptyIds] of Object.entries(state.ptyIdsByTabId)) {
    if (!ptyIds.includes(ptyId)) {
      continue
    }
    for (const tabs of Object.values(state.tabsByWorktree)) {
      const tab = tabs.find((entry) => entry.id === tabId)
      if (tab && /codex/i.test(tab.title ?? '')) {
        return true
      }
    }
  }
  return false
}

function worktreeIdsForPtyIds(state: AppState, ptyIds: readonly string[]): string[] {
  const wanted = new Set(ptyIds)
  const worktreeIds: string[] = []
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const hasMatch = tabs.some((tab) =>
      (state.ptyIdsByTabId[tab.id] ?? []).some((ptyId) => wanted.has(ptyId))
    )
    if (hasMatch) {
      worktreeIds.push(worktreeId)
    }
  }
  return worktreeIds
}

async function getLiveCodexSessionPtyIds(state: AppState): Promise<string[]> {
  // Why: remote session snapshots can populate PTY mappings before their tab
  // mirrors appear in tabsByWorktree. The PTY map is the liveness source used
  // by the terminal/session UI, so discover account-switch candidates there.
  const ptyIds = [...new Set(Object.values(state.ptyIdsByTabId).flat())]
  const checks = await Promise.all(
    ptyIds.map(async (ptyId) => {
      // Why: Codex sessions are not reliably discoverable from tab labels.
      // Tabs keep fallback names until a CLI emits an OSC title, and Codex
      // does not always do that. The foreground PTY process is the stable
      // source of truth for whether this live tab is actually running Codex.
      const foregroundProcess = await inspectRuntimeTerminalProcess(state.settings, ptyId).then(
        (inspection) => inspection.foregroundProcess,
        // Why: remote tab mirrors can briefly retain an expired handle. One
        // failed inspection must not suppress notices for every other session.
        () => null
      )
      if (isCodexForegroundProcess(foregroundProcess)) {
        return ptyId
      }
      // Why: on remote Linux, the FG process is often `node` while the tab
      // title still carries "codex". Without this fallback, Restart Session
      // never marks (or only partially marks) LXC1 sessions.
      if (
        foregroundProcess &&
        normalizeProcessName(foregroundProcess) === 'node' &&
        tabTitleLooksLikeCodex(state, ptyId)
      ) {
        return ptyId
      }
      if (!foregroundProcess && tabTitleLooksLikeCodex(state, ptyId)) {
        return ptyId
      }
      return null
    })
  )

  return checks.filter((ptyId): ptyId is string => ptyId !== null)
}

export async function markLiveCodexSessionsForRestart(args: {
  previousAccountLabel: string
  nextAccountLabel: string
}): Promise<void> {
  const state = useAppStore.getState()
  const liveCodexSessionPtyIds = await getLiveCodexSessionPtyIds(state)
  if (liveCodexSessionPtyIds.length === 0) {
    return
  }

  useAppStore.getState().markCodexRestartNotices(
    liveCodexSessionPtyIds.map((ptyId) => ({
      ptyId,
      previousAccountLabel: args.previousAccountLabel,
      nextAccountLabel: args.nextAccountLabel
    }))
  )
}

/**
 * Queue pane restarts and activate each worktree so mounted TerminalPanes
 * actually consume `pendingCodexPaneRestartIds`. Without activation, only the
 * currently visible worktree restarts — remote LXC1 multi-card sessions look
 * "broken" when Restart Session is clicked.
 */
export async function executeCodexSessionRestarts(ptyIds: readonly string[]): Promise<void> {
  if (ptyIds.length === 0) {
    return
  }
  const store = useAppStore.getState()
  store.queueCodexPaneRestarts([...ptyIds])

  const worktreeIds = worktreeIdsForPtyIds(store, ptyIds)
  if (worktreeIds.length === 0) {
    return
  }

  const previousWorktreeId = store.activeWorktreeId
  store.setActiveView('terminal')

  for (const worktreeId of worktreeIds) {
    store.setActiveWorktree(worktreeId)
    // Why: TerminalPane only mounts for the active worktree; give React a
    // tick so the pending-restart effect can run before we move on.
    await new Promise((resolve) => {
      window.setTimeout(resolve, 150)
    })
  }

  if (previousWorktreeId && worktreeIds.includes(previousWorktreeId)) {
    store.setActiveWorktree(previousWorktreeId)
  }
}
