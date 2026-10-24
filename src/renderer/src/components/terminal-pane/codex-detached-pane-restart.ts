/**
 * Detached executor for accepted account-switch restarts (Codex and Claude).
 *
 * Why: queued restarts used to execute only inside mounted TerminalPane
 * instances, so accepting the prompt stranded every unmounted pane — prompt
 * gone, keyboard blocked, Codex still running under the old account until the
 * tab was next revealed. This driver watches pendingPaneAccountRestarts and
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
import { CODEX_ACCOUNT_RESTART_STARTUP } from '@/lib/codex-session-restart'
import { isClaudePaneMidTurn } from '@/lib/claude-session-account-move'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import { isForeignMachineCodexPtyId } from '@/lib/codex-pane-selection-lane'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { ptyDataHandlers } from './pty-dispatcher'
import { collectLeafIds } from '../../../../shared/terminal-pane-layout-tree'
import { buildPaneIdentityEnv, getWorkspacePath } from './detached-pane-restart-spawn-context'
import { restartPaneOwner } from './codex-restart-main-pane'
import {
  hasFreeDetachedRestartSlot,
  holdDetachedRestartSlot,
  resetDetachedRestartSlotsForTests
} from './detached-pane-restart-slots'
import {
  killReplacedCodexPanePty,
  reapUnboundCodexPty,
  releaseReplacedCodexPanePty
} from './detached-pane-restart-pty-release'

const inFlightPtyIds = new Set<string>()

export function resetDetachedCodexPaneRestartClaimsForTests(): void {
  inFlightPtyIds.clear()
  resetDetachedRestartSlotsForTests()
}

export async function sweepUnclaimedCodexPaneRestarts(onSettled?: () => void): Promise<void> {
  const restarts: Promise<void>[] = []
  for (const ptyId of Object.keys(useAppStore.getState().pendingPaneAccountRestarts)) {
    if (!hasFreeDetachedRestartSlot()) {
      break
    }
    restarts.push(restartUnclaimedPane(ptyId, onSettled))
  }
  await Promise.all(restarts)
}

async function restartUnclaimedPane(ptyId: string, onSettled?: () => void): Promise<void> {
  let located: LocatedCodexPane | null = null
  let releaseSlot: (() => void) | null = null
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
        if (state.consumePendingPaneAccountRestart(ptyId)) {
          state.clearCodexRestartNotice(ptyId)
        }
      }
      return
    }
    // Why the registry check too: a revealed tab reads its layout into a ref at
    // mount, before its transports bind (and register a primary handler). A
    // takeover in that window would kill the PTY the pane is attaching to.
    if (hasRegisteredRuntimeTerminalTab(located.tab.id, located.worktreeId)) {
      return
    }
    // Why: a Claude restart waits out the turn; the scheduler re-sweeps on status changes.
    if (
      state.pendingPaneAccountRestarts[ptyId] === 'claude' &&
      located.leafId &&
      isClaudePaneMidTurn(state, makePaneKey(located.tab.id, located.leafId))
    ) {
      return
    }
    const agent = useAppStore.getState().consumePendingPaneAccountRestart(ptyId)
    if (!agent) {
      return
    }
    inFlightPtyIds.add(ptyId)
    const claimedPane = located
    releaseSlot = holdDetachedRestartSlot(ptyId, () => {
      console.warn('[codex-restart] detached restart spawn stalled; asking again')
      // Why: a late result still adopts and clears this prompt, since main may have stopped the old PTY.
      reopenCurrentCodexRestartPrompt(claimedPane, ptyId)
      onSettled?.()
    })
    await executeDetachedCodexPaneRestart(located, ptyId, agent)
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
    if (releaseSlot) {
      releaseSlot()
      inFlightPtyIds.delete(ptyId)
      onSettled?.()
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

async function executeDetachedCodexPaneRestart(
  located: LocatedCodexPane,
  ptyId: string,
  agent: AccountRestartAgent
): Promise<void> {
  const state = useAppStore.getState()
  if (!located.leafId) {
    // Why: Claude cannot resume without a leaf's session, and a fresh Claude would lose the conversation.
    if (agent === 'claude') {
      return
    }
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
  const startup = buildPaneAccountRestartStartup(agent, {
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
  if (!isLocatedCodexPaneCurrent(currentState, located, ptyId)) {
    reopenCurrentCodexRestartPrompt(located, ptyId)
    return
  }
  if (hasRegisteredRuntimeTerminalTab(tab.id, worktreeId) || ptyDataHandlers.has(ptyId)) {
    currentState.queuePaneAccountRestarts([ptyId], agent)
    return
  }
  const paneOwner = restartPaneOwner(currentState, worktreeId, tab.id, leafId)
  if (paneOwner === 'missing') {
    // A pane main's layout lacks has no tab to start into; a graft would invent one (L197).
    reopenCurrentCodexRestartPrompt(located, ptyId)
    return
  }

  // Hidden replacements converge on mount; provider sizing must not delay ownership transfer.
  // Main stops `ptyId` first and labels its exit as a replacement, so parked watchers and the
  // pre-attach buffer leave the pane alone; a failed stop sends no exit and changes nothing here.
  const spawned = await window.api.pty.spawn({
    cols: 80,
    rows: 24,
    ...(cwd ? { cwd } : {}),
    ...startup,
    env: { ...startup.env, ...buildPaneIdentityEnv(state, worktreeId, tab.id, leafId) },
    worktreeId,
    tabId: tab.id,
    leafId,
    replacesPtyId: ptyId,
    ...(paneOwner === 'window' &&
    restartReplacesLayoutRoot(currentState.terminalLayoutsByTabId[tab.id], leafId)
      ? { placement: { kind: 'root' as const } }
      : {}),
    ...(tab.shellOverride ? { shellOverride: tab.shellOverride } : {}),
    ...(projectRuntime ? { projectRuntime } : {}),
    initiallyHidden: true
  })

  // Why adopt rather than stand down: main stopped `ptyId` before replying, so the replacement is
  // the pane's only process — even if that exit already cleared the old binding or a pane mounted.
  const store = useAppStore.getState()
  if (!isLocatedCodexPaneLeafAdoptable(store, located, ptyId, spawned.id)) {
    reopenCurrentCodexRestartPrompt(located, ptyId)
    reapUnboundCodexPty(spawned.id, 'stale detached spawn')
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
  if (paneOwner === 'window') {
    rebindCodexPaneLayoutLeaf(tab.id, leafId, spawned.id)
  }
  // Why both ids: updateTabPtyId migrates the replaced pane's notice onto the
  // new PTY; the restart it recorded is now done, so the block must lift.
  store.clearCodexRestartNotice(spawned.id)
  store.clearCodexRestartNotice(ptyId)
  releaseReplacedCodexPanePty(ptyId)
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

function isLocatedCodexPaneLeafAdoptable(
  state: AppState,
  located: LocatedCodexPane,
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

function rebindCodexPaneLayoutLeaf(tabId: string, leafId: string, newPtyId: string): void {
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
