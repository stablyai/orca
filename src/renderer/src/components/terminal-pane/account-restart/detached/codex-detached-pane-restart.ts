/** Execute accepted Codex/Claude account restarts and manual agent restarts for unmounted local panes so input cannot stay blocked until reveal. */
import { isTerminalLeafId } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { useAppStore } from '@/store/index'
import { singlePaneLayoutSnapshot } from '@/store/terminals/layout/terminal-single-pane-layout'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import {
  buildCodexAccountRestartStartup,
  buildManualRestartStartup,
  buildPaneAccountRestartStartup
} from '@/lib/agent-session/accounts/agent-account-restart-startup'
import { isForeignMachineCodexPtyId } from '@/lib/agent-session/accounts/codex-pane-selection-lane'
import { getLocalProjectExecutionRuntimeContext } from '@/runtime/hosts/preflight/local-preflight-context'
import {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities
} from '@/runtime/hosts/capabilities/windows-terminal-capabilities'
import '../../pty-transport/delivery/pty-dispatcher'
import { ptyDataHandlers } from '../../pty-transport/shutdown/pty-shutdown-data-suspension'
import { collectLeafIds } from '../../../../../../shared/workspace-layout/terminal-topology/terminal-pane-layout-tree'
import { buildPaneIdentityEnv, getWorkspacePath } from './detached-pane-restart-spawn-context'
import { restartPaneOwner } from '../pane-ownership/codex-restart-main-pane'
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
import type { TerminalLayoutSnapshot } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { isLocatedCodexPaneCurrent, isLocatedCodexPaneLeafAdoptable } from './located-codex-pane'
import type { LocatedCodexPane } from './located-codex-pane'
import type { AppState } from '@/store/types'
import type { PendingPaneRestart } from '@/store/terminals/terminal-contracts'

const inFlightPtyIds = new Set<string>()

export function isDetachedRestartInFlight(ptyId: string): boolean {
  return inFlightPtyIds.has(ptyId)
}

export function resetDetachedCodexPaneRestartClaimsForTests(): void {
  inFlightPtyIds.clear()
  resetDetachedRestartSlotsForTests()
}

export async function sweepUnclaimedCodexPaneRestarts(onSettled?: () => void): Promise<void> {
  const restarts: Promise<void>[] = []
  const { pendingPaneAccountRestarts, pendingPaneManualRestarts } = useAppStore.getState()
  const queuedPtyIds = new Set([
    ...Object.keys(pendingPaneAccountRestarts),
    ...Object.keys(pendingPaneManualRestarts)
  ])
  for (const ptyId of queuedPtyIds) {
    if (!hasFreeDetachedRestartSlot()) {
      break
    }
    restarts.push(restartUnclaimedPane(ptyId, onSettled))
  }
  await Promise.all(restarts)
}

async function restartUnclaimedPane(ptyId: string, onSettled?: () => void): Promise<void> {
  let located: LocatedCodexPane | null = null
  let restart: PendingPaneRestart | null = null
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
      // Why: no tab owns this PTY, so a manual restart has no conversation left to resume.
      state.dropPendingPaneManualRestart(ptyId)
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
    restart = useAppStore.getState().consumePendingPaneRestart(ptyId)
    if (!restart) {
      return
    }
    inFlightPtyIds.add(ptyId)
    const claimedPane = located
    const claimedIntent = restart.intent
    releaseSlot = holdDetachedRestartSlot(ptyId, () => {
      console.warn('[codex-restart] detached restart spawn stalled; asking again')
      // Why: a late result still adopts and clears this prompt, since main may have stopped the old PTY.
      if (claimedIntent === 'account') {
        reopenCurrentCodexRestartPrompt(claimedPane, ptyId)
      }
      onSettled?.()
    })
    await executeDetachedCodexPaneRestart(located, ptyId, restart)
  } catch (err) {
    console.warn('[codex-restart] detached pane restart failed:', err)
    // Why: a manual restart never answered a Codex prompt, so there is none to reopen.
    if (restart?.intent === 'manual') {
      return
    }
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
  { agent, intent }: PendingPaneRestart
): Promise<void> {
  const state = useAppStore.getState()
  // Why: only an account switch answered a Codex prompt, so only it may reopen one.
  const reopenAccountPrompt = (): void => {
    if (intent === 'account') {
      reopenCurrentCodexRestartPrompt(located, ptyId)
    }
  }
  if (!located.leafId) {
    // Why: Claude and manual restarts cannot resume without a leaf's session, and a fresh launch would lose the conversation.
    if (intent === 'manual' || agent === 'claude') {
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
  const pane = { worktreeId, tabId: tab.id, leafId, shellOverride: tab.shellOverride }
  const startup =
    intent === 'manual'
      ? buildManualRestartStartup(agent, pane)
      : buildPaneAccountRestartStartup(agent, pane)
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
    reopenAccountPrompt()
    return
  }
  if (hasRegisteredRuntimeTerminalTab(tab.id, worktreeId) || ptyDataHandlers.has(ptyId)) {
    // Why: an account queue entry would give a manual restart a fresh-Codex fallback.
    if (intent === 'manual') {
      currentState.queuePaneManualRestarts([{ ptyId, agent }])
    } else {
      currentState.queuePaneAccountRestarts([ptyId], agent)
    }
    return
  }
  const paneOwner = restartPaneOwner(currentState, worktreeId, tab.id, leafId)
  if (paneOwner === 'missing') {
    // A pane main's layout lacks has no tab to start into; a graft would invent one (L197).
    reopenAccountPrompt()
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
    reopenAccountPrompt()
    reapUnboundCodexPty(spawned.id, 'stale detached spawn')
    return
  }
  store.updateTabPtyId(tab.id, spawned.id, ptyId)
  if (!useAppStore.getState().ptyIdsByTabId[tab.id]?.includes(spawned.id)) {
    // Reap a replacement whose tab retired during spawn so no unbound PTY leaks in the daemon.
    if (intent === 'account') {
      store.clearCodexRestartNotice(ptyId)
    }
    reapUnboundCodexPty(spawned.id, 'retired-tab spawn')
    return
  }
  if (paneOwner === 'window') {
    rebindCodexPaneLayoutLeaf(tab.id, leafId, spawned.id)
  }
  // Clear both notice IDs because rebinding migrates the old notice onto the replacement PTY.
  if (intent === 'account') {
    store.clearCodexRestartNotice(spawned.id)
    store.clearCodexRestartNotice(ptyId)
  }
  releaseReplacedCodexPanePty(ptyId)
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
