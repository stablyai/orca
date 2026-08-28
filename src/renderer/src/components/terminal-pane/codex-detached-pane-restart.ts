/**
 * Detached executor for accepted Codex account-switch restarts.
 *
 * Why: queued restarts used to execute only inside mounted TerminalPane
 * instances, so accepting the prompt stranded every unmounted pane — prompt
 * gone, keyboard blocked, Codex still running under the old account until the
 * tab was next revealed. This driver watches pendingCodexPaneRestartIds and
 * kill-and-respawns any pane no mounted transport claims, rebinding the store
 * so a later mount reattaches to the replacement PTY like a restored session.
 */
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { TerminalPaneLayoutNode, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/sync-runtime-graph'
import { CODEX_ACCOUNT_RESTART_STARTUP } from '@/lib/codex-session-restart'
import { isForeignMachineCodexPtyId } from '@/lib/codex-pane-selection-lane'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { ptyDataHandlers, unregisterPtyDataHandlers } from './pty-dispatcher'
import { discardPreHandlerPtyState } from './pty-pre-handler-buffer'
import { disposeParkedTerminalWatchersForPtyIds } from './terminal-parked-watcher-registry'

const inFlightPtyIds = new Set<string>()

export function resetDetachedCodexPaneRestartClaimsForTests(): void {
  inFlightPtyIds.clear()
}

export async function sweepUnclaimedCodexPaneRestarts(): Promise<void> {
  for (const ptyId of Object.keys(useAppStore.getState().pendingCodexPaneRestartIds)) {
    await sweepUnclaimedCodexPaneRestart(ptyId)
  }
}

async function sweepUnclaimedCodexPaneRestart(ptyId: string): Promise<void> {
  let located: LocatedCodexPane | null = null
  let claimed = false
  try {
    // Why: remote-runtime spawns need that machine's transport assembly, which
    // only the mounted pane path carries today; leave those queued for mount.
    if (isForeignMachineCodexPtyId(ptyId)) {
      return
    }
    // Why: a live primary handler means a mounted pane owns this PTY, and its
    // restart effect re-runs on both the queue write and the transport bind —
    // it is guaranteed to claim, and only it can reconnect the xterm in place.
    if (ptyDataHandlers.has(ptyId) || inFlightPtyIds.has(ptyId)) {
      return
    }
    const state = useAppStore.getState()
    located = locateCodexPane(state, ptyId)
    if (!located) {
      // Why not consume: a sleep-retained pending id is unbound on purpose and
      // wake migrates it onto the respawned PTY — taking it here would lose
      // that restart. Only a notice still muting input forces a resolution.
      if (state.codexRestartNoticeByPtyId[ptyId]) {
        if (state.consumePendingCodexPaneRestart(ptyId)) {
          state.clearCodexRestartNotice(ptyId)
        }
      }
      return
    }
    // Why the registry check too: a revealed tab reads its layout into a ref at
    // mount, before its transports bind (and register a primary handler). A
    // takeover in that window would kill the PTY the pane is attaching to.
    if (hasRegisteredRuntimeTerminalTab(located.tab.id)) {
      return
    }
    if (!useAppStore.getState().consumePendingCodexPaneRestart(ptyId)) {
      return
    }
    inFlightPtyIds.add(ptyId)
    claimed = true
    await executeDetachedCodexPaneRestart(located, ptyId)
  } catch (err) {
    console.warn('[codex-restart] detached pane restart failed:', err)
    // Why: one malformed claim must not abort later panes or leave this one with
    // an answered prompt whose restart never executed.
    if (located) {
      reopenCurrentCodexRestartPrompt(located, ptyId)
    } else {
      useAppStore.getState().reopenCodexRestartPrompt(ptyId)
    }
  } finally {
    if (claimed) {
      inFlightPtyIds.delete(ptyId)
    }
  }
}

type LocatedCodexPane = {
  worktreeId: string
  tab: TerminalTab
  leafId: string | null
  generation: number
}

function locateCodexPane(state: AppState, ptyId: string): LocatedCodexPane | null {
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.ptyId !== ptyId && !(state.ptyIdsByTabId[tab.id] ?? []).includes(ptyId)) {
        continue
      }
      const leafId =
        Object.entries(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}).find(
          ([, boundPtyId]) => boundPtyId === ptyId
        )?.[0] ?? null
      // Why the format check: pre-UUID layouts carry numeric leaf ids, which the
      // pane-key env and main's binding flush both reject.
      return {
        worktreeId,
        tab,
        leafId: leafId !== null && isTerminalLeafId(leafId) ? leafId : null,
        generation: tab.generation ?? 0
      }
    }
  }
  return null
}

function getWorkspacePath(state: AppState, worktreeId: string): string | null {
  const parsed = parseWorkspaceKey(worktreeId)
  if (parsed?.type === 'folder') {
    return (
      (state.folderWorkspaces ?? []).find((workspace) => workspace.id === parsed.folderWorkspaceId)
        ?.folderPath ?? null
    )
  }
  return getWorktreeMapFromState(state).get(worktreeId)?.path ?? null
}

function buildPaneIdentityEnv(
  state: AppState,
  worktreeId: string,
  tabId: string,
  leafId: string
): Record<string, string> {
  const parsed = parseWorkspaceKey(worktreeId)
  const folderWorkspace =
    parsed?.type === 'folder'
      ? state.folderWorkspaces.find((workspace) => workspace.id === parsed.folderWorkspaceId)
      : null
  return {
    ORCA_WORKSPACE_ID: worktreeId,
    ...(folderWorkspace
      ? {
          ORCA_PROJECT_GROUP_ID: folderWorkspace.projectGroupId,
          ORCA_WORKSPACE_ROOT: folderWorkspace.folderPath
        }
      : {}),
    ORCA_PANE_KEY: makePaneKey(tabId, leafId),
    ORCA_TAB_ID: tabId,
    ORCA_WORKTREE_ID: worktreeId
  }
}

async function executeDetachedCodexPaneRestart(
  located: LocatedCodexPane,
  ptyId: string
): Promise<void> {
  const state = useAppStore.getState()
  if (!located.leafId) {
    // Why: without a usable layout leaf the replacement cannot be bound in
    // place, so kill now and let the tab's next mount run the Codex startup.
    if (!isLocatedCodexPaneCurrent(state, located, ptyId)) {
      reopenCurrentCodexRestartPrompt(located, ptyId)
      return
    }
    const store = useAppStore.getState()
    store.suppressPtyExit(ptyId)
    store.clearTabPtyId(located.tab.id, ptyId)
    store.consumeSuppressedPtyExit(ptyId)
    store.queueTabStartupCommand(located.tab.id, { ...CODEX_ACCOUNT_RESTART_STARTUP })
    store.clearCodexRestartNotice(ptyId)
    killReplacedCodexPanePty(ptyId)
    return
  }
  const { worktreeId, tab, leafId } = located

  const workspacePath = getWorkspacePath(state, worktreeId)
  const cwd = tab.startupCwd ?? workspacePath ?? undefined
  const capabilities = hasCachedWindowsTerminalCapabilities()
    ? getCachedWindowsTerminalCapabilities()
    : null
  // Why: same runtime context the mounted spawn ships (pty-connection.ts), so a
  // WSL-defaulted project respawns into the same distro it launched from.
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId, undefined, {
    wslAvailable: capabilities?.wslAvailable,
    availableWslDistros: capabilities?.wslDistros ?? null
  })

  const currentState = useAppStore.getState()
  if (!isLocatedCodexPaneCurrent(currentState, located, ptyId)) {
    reopenCurrentCodexRestartPrompt(located, ptyId)
    return
  }
  if (hasRegisteredRuntimeTerminalTab(tab.id) || ptyDataHandlers.has(ptyId)) {
    currentState.queueCodexPaneRestarts([ptyId])
    return
  }

  // Hidden replacements converge on mount; provider sizing must not delay ownership transfer.
  const spawned = await window.api.pty.spawn({
    cols: 80,
    rows: 24,
    ...(cwd ? { cwd } : {}),
    cwdFallback: 'worktree',
    env: buildPaneIdentityEnv(state, worktreeId, tab.id, leafId),
    command: CODEX_ACCOUNT_RESTART_STARTUP.command,
    startupCommandDelivery: CODEX_ACCOUNT_RESTART_STARTUP.startupCommandDelivery,
    launchAgent: CODEX_ACCOUNT_RESTART_STARTUP.launchAgent,
    worktreeId,
    tabId: tab.id,
    leafId,
    ...(tab.shellOverride ? { shellOverride: tab.shellOverride } : {}),
    ...(projectRuntime ? { projectRuntime } : {}),
    initiallyHidden: true
  })

  const store = useAppStore.getState()
  if (!isLocatedCodexPaneCurrent(store, located, ptyId)) {
    reopenCurrentCodexRestartPrompt(located, ptyId)
    reapUnboundCodexPty(spawned.id, 'stale detached spawn')
    return
  }
  if (hasRegisteredRuntimeTerminalTab(tab.id) || ptyDataHandlers.has(ptyId)) {
    store.queueCodexPaneRestarts([ptyId])
    reapUnboundCodexPty(spawned.id, 'mounted-owner handoff spawn')
    return
  }
  store.updateTabPtyId(tab.id, spawned.id, ptyId)
  if (!useAppStore.getState().ptyIdsByTabId[tab.id]?.includes(spawned.id)) {
    // Why: the tab was retired while the spawn was in flight; without a binding
    // the fresh PTY would idle in the daemon forever, so reap it and stand down.
    store.clearCodexRestartNotice(ptyId)
    reapUnboundCodexPty(spawned.id, 'retired-tab spawn')
    return
  }
  rebindCodexPaneLayoutLeaf(tab.id, leafId, spawned.id)
  // Why both ids: updateTabPtyId migrates the replaced pane's notice onto the
  // new PTY; the restart it recorded is now done, so the block must lift.
  store.clearCodexRestartNotice(spawned.id)
  store.clearCodexRestartNotice(ptyId)

  killReplacedCodexPanePty(ptyId)
}

function isLocatedCodexPaneCurrent(
  state: AppState,
  located: LocatedCodexPane,
  ptyId: string
): boolean {
  const currentTab = state.tabsByWorktree[located.worktreeId]?.find(
    (candidate) => candidate.id === located.tab.id
  )
  if (
    !currentTab ||
    currentTab.worktreeId !== located.worktreeId ||
    (currentTab.generation ?? 0) !== located.generation ||
    !(state.ptyIdsByTabId[located.tab.id] ?? []).includes(ptyId)
  ) {
    return false
  }
  return (
    located.leafId === null ||
    state.terminalLayoutsByTabId[located.tab.id]?.ptyIdsByLeafId?.[located.leafId] === ptyId
  )
}

function reopenCurrentCodexRestartPrompt(located: LocatedCodexPane, replacedPtyId: string): void {
  const state = useAppStore.getState()
  const currentTab = state.tabsByWorktree[located.worktreeId]?.find(
    (candidate) => candidate.id === located.tab.id
  )
  const currentPtyId = located.leafId
    ? state.terminalLayoutsByTabId[located.tab.id]?.ptyIdsByLeafId?.[located.leafId]
    : currentTab?.ptyId
  for (const candidate of [currentPtyId, replacedPtyId]) {
    if (candidate && state.codexRestartNoticeByPtyId[candidate]?.restartRequested) {
      state.reopenCodexRestartPrompt(candidate)
      return
    }
  }
}

function layoutRootContainsLeaf(
  node: TerminalPaneLayoutNode | null | undefined,
  leafId: string
): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId
  }
  return layoutRootContainsLeaf(node.first, leafId) || layoutRootContainsLeaf(node.second, leafId)
}

function rebindCodexPaneLayoutLeaf(tabId: string, leafId: string, newPtyId: string): void {
  const store = useAppStore.getState()
  const layout = store.terminalLayoutsByTabId[tabId]
  const boundLeafIds = Object.keys(layout?.ptyIdsByLeafId ?? {})
  // Why: mount replays panes from the root — a root that doesn't name this leaf
  // mints a fresh one and silently orphans the replacement PTY. Rewriting is
  // only safe when this is the tab's sole bound pane; a split keeps its root.
  if (!layoutRootContainsLeaf(layout?.root, leafId) && boundLeafIds.every((id) => id === leafId)) {
    store.setTabLayout(
      tabId,
      singlePaneLayoutSnapshot(leafId, newPtyId, layout?.titlesByLeafId?.[leafId] ?? null)
    )
    return
  }
  store.replaceTerminalLayoutPanePtyId(tabId, leafId, newPtyId)
}

function reapUnboundCodexPty(ptyId: string, reason: string): void {
  try {
    void window.api.pty.kill(ptyId).catch((err) => {
      console.warn(`[codex-restart] failed to reap ${reason}:`, err)
    })
  } catch (err) {
    console.warn(`[codex-restart] failed to reap ${reason}:`, err)
  }
  discardPreHandlerPtyState(ptyId)
}

function killReplacedCodexPanePty(ptyId: string): void {
  // Why the disposal: a parked tab's exit sidecar treats any exit as the pane
  // dying — it would collapse the just-rebound leaf or close the whole tab.
  disposeParkedTerminalWatchersForPtyIds([ptyId])
  for (const snapshot of unregisterPtyDataHandlers([ptyId])) {
    snapshot.commit()
  }
  reapUnboundCodexPty(ptyId, 'replaced Codex pane PTY')
}
