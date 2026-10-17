/**
 * Detached executor for accepted account-switch restarts, for every account-switch agent.
 *
 * Why: queued restarts used to execute only inside mounted TerminalPane
 * instances, so accepting the prompt stranded every unmounted pane on the old
 * account until the tab was next revealed. This driver watches pendingPaneAccountRestarts and
 * kill-and-respawns any pane no mounted transport claims, rebinding the store
 * so a later mount reattaches to the replacement PTY like a restored session.
 */
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/mounted-terminal-tab-registry'
import { buildPaneAccountRestartStartup } from '@/lib/agent-account-restart-startup'
import { ACCOUNT_SWITCH_AGENTS } from '@/lib/agent-account-switch-agents'
import { isQueuedAccountRestartReady } from './pane-account-restart-readiness'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import { isForeignMachinePtyId } from '@/lib/pane-account-selection-lane'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { ptyDataHandlers, unregisterPtyDataHandlers } from './pty-dispatcher'
import { collectLeafIds } from './terminal-pane-layout-tree'
import { discardPreHandlerPtyState } from './pty-pre-handler-buffer'
import { disposeParkedTerminalWatchersForPtyIds } from './terminal-parked-watcher-registry'
import { getWorkspacePath } from '@/lib/workspace-directory'
import { buildPaneIdentityEnv } from './detached-pane-restart-spawn-context'

// Why no in-flight registry: the scheduler never overlaps sweeps, and consuming the queued entry is the claim.
export async function sweepUnclaimedPaneAccountRestarts(): Promise<void> {
  for (const ptyId of Object.keys(useAppStore.getState().pendingPaneAccountRestarts)) {
    await sweepUnclaimedPaneAccountRestart(ptyId)
  }
}

async function sweepUnclaimedPaneAccountRestart(ptyId: string): Promise<void> {
  try {
    // Why: remote-runtime spawns need that machine's transport assembly, which
    // only the mounted pane path carries today; leave those queued for mount.
    if (isForeignMachinePtyId(ptyId)) {
      return
    }
    // Why: a live primary handler means a mounted pane owns this PTY, and its
    // restart effect re-runs on both the queue write and the transport bind —
    // it is guaranteed to claim, and only it can reconnect the xterm in place.
    if (ptyDataHandlers.has(ptyId)) {
      return
    }
    const state = useAppStore.getState()
    const located = locatePane(state, ptyId)
    if (!located) {
      // Why not consume: a sleep-retained pending id is unbound on purpose and
      // wake migrates it onto the respawned PTY — taking it here would lose that restart.
      return
    }
    // Why the registry check too: a revealed tab reads its layout into a ref at
    // mount, before its transports bind (and register a primary handler). A
    // takeover in that window would kill the PTY the pane is attaching to.
    if (hasRegisteredRuntimeTerminalTab(located.tab.id, located.worktreeId)) {
      return
    }
    // Why: some agents' restarts wait out the turn; the scheduler re-sweeps on status changes.
    const queued = state.pendingPaneAccountRestarts[ptyId]
    if (
      queued &&
      located.leafId &&
      !isQueuedAccountRestartReady(state, queued, makePaneKey(located.tab.id, located.leafId))
    ) {
      return
    }
    const agent = useAppStore.getState().consumePendingPaneAccountRestart(ptyId)
    if (!agent) {
      return
    }
    await executeDetachedPaneAccountRestart(located, ptyId, agent)
  } catch (err) {
    // Why caught: one malformed claim must not abort later panes; this one stays on its account.
    console.warn('[account-restart] detached pane restart failed:', err)
  }
}

type LocatedPane = {
  worktreeId: string
  tab: TerminalTab
  leafId: string | null
  generation: number
}

function locatePane(state: AppState, ptyId: string): LocatedPane | null {
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

async function executeDetachedPaneAccountRestart(
  located: LocatedPane,
  ptyId: string,
  agent: AccountRestartAgent
): Promise<void> {
  const state = useAppStore.getState()
  if (!located.leafId) {
    // Why: an agent that only resumes cannot without a leaf's session, and a fresh one would lose it.
    const { freshStartup } = ACCOUNT_SWITCH_AGENTS[agent]
    if (!freshStartup) {
      return
    }
    // Why: without a usable layout leaf the replacement cannot be bound in
    // place, so kill now and let the tab's next mount run the agent's fresh startup.
    if (!isLocatedPaneCurrent(state, located, ptyId)) {
      return
    }
    const store = useAppStore.getState()
    store.suppressPtyExit(ptyId)
    store.clearTabPtyId(located.tab.id, ptyId)
    store.consumeSuppressedPtyExit(ptyId)
    store.queueTabStartupCommand(located.tab.id, { ...freshStartup })
    killReplacedPanePty(ptyId)
    return
  }
  const { worktreeId, tab, leafId } = located
  const startup = buildPaneAccountRestartStartup(ACCOUNT_SWITCH_AGENTS[agent], {
    worktreeId,
    tabId: tab.id,
    leafId,
    shellOverride: tab.shellOverride
  })
  if (!startup) {
    return
  }

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
  if (!isLocatedPaneCurrent(currentState, located, ptyId)) {
    return
  }
  if (hasRegisteredRuntimeTerminalTab(tab.id, worktreeId) || ptyDataHandlers.has(ptyId)) {
    currentState.queuePaneAccountRestarts([ptyId], agent)
    return
  }

  // Hidden replacements converge on mount; provider sizing must not delay ownership transfer.
  // Main stops `ptyId` first and labels its exit as a replacement, so parked watchers and the
  // pre-attach buffer leave the pane alone; a failed stop sends no exit and changes nothing here.
  const spawned = await window.api.pty.spawn({
    cols: 80,
    rows: 24,
    ...(cwd ? { cwd } : {}),
    cwdFallback: 'worktree',
    ...startup,
    env: { ...startup.env, ...buildPaneIdentityEnv(state, worktreeId, tab.id, leafId) },
    worktreeId,
    tabId: tab.id,
    leafId,
    replacesPtyId: ptyId,
    ...(restartReplacesLayoutRoot(currentState.terminalLayoutsByTabId[tab.id], leafId)
      ? { placement: { kind: 'root' as const } }
      : {}),
    ...(tab.shellOverride ? { shellOverride: tab.shellOverride } : {}),
    ...(projectRuntime ? { projectRuntime } : {}),
    initiallyHidden: true
  })

  // Why adopt rather than stand down: main stopped `ptyId` before replying, so the replacement is
  // the pane's only process — even if that exit already cleared the old binding or a pane mounted.
  const store = useAppStore.getState()
  if (!isLocatedPaneLeafAdoptable(store, located, ptyId, spawned.id)) {
    reapUnboundPty(spawned.id, 'stale detached spawn')
    return
  }
  store.updateTabPtyId(tab.id, spawned.id, ptyId)
  if (!useAppStore.getState().ptyIdsByTabId[tab.id]?.includes(spawned.id)) {
    // Why: the tab was retired while the spawn was in flight; without a binding
    // the fresh PTY would idle in the daemon forever, so reap it and stand down.
    reapUnboundPty(spawned.id, 'retired-tab spawn')
    return
  }
  rebindPaneLayoutLeaf(tab.id, leafId, spawned.id)
  releaseReplacedPanePty(ptyId)
}

function isLocatedPaneCurrent(state: AppState, located: LocatedPane, ptyId: string): boolean {
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

function isLocatedPaneLeafAdoptable(
  state: AppState,
  located: LocatedPane,
  replacedPtyId: string,
  replacementPtyId: string
): boolean {
  const currentTab = state.tabsByWorktree[located.worktreeId]?.find(
    (candidate) => candidate.id === located.tab.id
  )
  if (!currentTab || (currentTab.generation ?? 0) !== located.generation || !located.leafId) {
    return false
  }
  const boundPtyId = state.terminalLayoutsByTabId[located.tab.id]?.ptyIdsByLeafId?.[located.leafId]
  return boundPtyId === replacedPtyId || boundPtyId === replacementPtyId
}

// Why: mount replays panes from the root — a root that doesn't name this leaf
// mints a fresh one and silently orphans the replacement PTY. Rewriting is
// only safe when this is the tab's sole bound pane; a split keeps its root.
function restartReplacesLayoutRoot(
  layout: TerminalLayoutSnapshot | undefined,
  leafId: string
): boolean {
  return (
    !collectLeafIds(layout?.root).includes(leafId) &&
    Object.keys(layout?.ptyIdsByLeafId ?? {}).every((id) => id === leafId)
  )
}

function rebindPaneLayoutLeaf(tabId: string, leafId: string, newPtyId: string): void {
  const store = useAppStore.getState()
  const layout = store.terminalLayoutsByTabId[tabId]
  if (restartReplacesLayoutRoot(layout, leafId)) {
    store.setTabLayout(
      tabId,
      singlePaneLayoutSnapshot(leafId, newPtyId, layout?.titlesByLeafId?.[leafId] ?? null)
    )
    return
  }
  store.replaceTerminalLayoutPanePtyId(tabId, leafId, newPtyId)
}

function reapUnboundPty(ptyId: string, reason: string): void {
  try {
    void window.api.pty.kill(ptyId).catch((err) => {
      console.warn(`[account-restart] failed to reap ${reason}:`, err)
    })
  } catch (err) {
    console.warn(`[account-restart] failed to reap ${reason}:`, err)
  }
  discardPreHandlerPtyState(ptyId)
}

function releaseReplacedPanePty(ptyId: string): void {
  // Why the disposal: a parked tab's exit sidecar treats an unlabeled exit as the pane
  // dying — it would collapse the just-rebound leaf or close the whole tab.
  disposeParkedTerminalWatchersForPtyIds([ptyId])
  for (const snapshot of unregisterPtyDataHandlers([ptyId])) {
    snapshot.commit()
  }
  discardPreHandlerPtyState(ptyId)
}

function killReplacedPanePty(ptyId: string): void {
  releaseReplacedPanePty(ptyId)
  reapUnboundPty(ptyId, 'replaced pane PTY')
}
