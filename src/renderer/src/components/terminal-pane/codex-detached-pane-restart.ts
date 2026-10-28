/** Execute accepted Codex/Claude account restarts for unmounted local panes so input cannot stay blocked until reveal. */
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/mounted-terminal-tab-registry'
import {
  buildCodexAccountRestartStartup,
  buildPaneAccountRestartStartup
} from '@/lib/agent-account-restart-startup'
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
    // Remote spawns need mounted transport assembly; leave them queued for mount.
    if (isForeignMachineCodexPtyId(ptyId)) {
      return
    }
    // Mounted primary handlers own restart and xterm reconnection, including queue writes racing transport bind.
    if (ptyDataHandlers.has(ptyId) || inFlightPtyIds.has(ptyId)) {
      return
    }
    const state = useAppStore.getState()
    located = locateCodexPane(state, ptyId)
    if (!located) {
      // Wake migrates sleeping unbound IDs; resolve missing ownership only when an extant notice still blocks input.
      if (state.codexRestartNoticeByPtyId[ptyId]) {
        if (state.consumePendingPaneAccountRestart(ptyId)) {
          state.clearCodexRestartNotice(ptyId)
        }
      }
      return
    }
    // Mounted tabs register before transport bind; taking over in that gap would kill the PTY being attached.
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
    // Contain each bad claim so later panes still restart and this prompt cannot remain silently answered.
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
      // Reject legacy numeric leaves because pane-key environment and main binding require UUIDs.
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
    // Without a usable layout leaf, stop the old PTY and let the next mount run Codex startup.
    if (!isLocatedCodexPaneCurrent(state, located, ptyId)) {
      reopenCurrentCodexRestartPrompt(located, ptyId)
      return
    }
    const startup = buildCodexAccountRestartStartup({
      worktreeId: located.worktreeId,
      shellOverride: located.tab.shellOverride
    })
    const store = useAppStore.getState()
    store.suppressPtyExit(ptyId)
    store.clearTabPtyId(located.tab.id, ptyId)
    store.consumeSuppressedPtyExit(ptyId)
    store.queueTabStartupCommand(located.tab.id, startup)
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
  // Carry the mounted spawn’s project runtime context so WSL-defaulted projects stay in the same distro.
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

  // Transfer hidden ownership without waiting for sizing; main labels replacement exits so parked/pre-attach handlers preserve the pane.
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

  // Adopt even after old-binding cleanup or mount races because main already stopped the old PTY and the replacement is the only process.
  const store = useAppStore.getState()
  if (!isLocatedCodexPaneLeafAdoptable(store, located, ptyId, spawned.id)) {
    reopenCurrentCodexRestartPrompt(located, ptyId)
    reapUnboundCodexPty(spawned.id, 'stale detached spawn')
    return
  }
  store.updateTabPtyId(tab.id, spawned.id, ptyId)
  if (!useAppStore.getState().ptyIdsByTabId[tab.id]?.includes(spawned.id)) {
    // Reap a replacement whose tab retired during spawn so no unbound PTY leaks in the daemon.
    store.clearCodexRestartNotice(ptyId)
    reapUnboundCodexPty(spawned.id, 'retired-tab spawn')
    return
  }
  if (paneOwner === 'window') {
    rebindCodexPaneLayoutLeaf(tab.id, leafId, spawned.id)
  }
  // Clear both notice IDs because rebinding migrates the old notice onto the replacement PTY.
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

// Rewrite only sole-pane roots to name the replacement leaf; split roots must retain siblings and reveal must not mint another leaf.
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
