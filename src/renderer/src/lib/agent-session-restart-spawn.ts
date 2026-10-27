import { useAppStore } from '@/store'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { collectLeafIds } from '../../../shared/terminal-pane-layout-tree'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import {
  buildPaneIdentityEnv,
  getWorkspacePath
} from '@/components/terminal-pane/detached-pane-restart-spawn-context'
import { restartPaneOwner } from '@/components/terminal-pane/codex-restart-main-pane'
import {
  reapUnboundCodexPty,
  releaseReplacedCodexPanePty
} from '@/components/terminal-pane/detached-pane-restart-pty-release'
import type { AgentSessionRestartPane } from './agent-session-restart-plan'
import type { AgentSessionRestartStartup } from './agent-session-restart-startup'
import {
  judgeAgentSessionRestartSpawn,
  type AgentSessionRestartSpawnResult
} from './agent-session-restart-verdict'
import { getMountedAgentSessionRestart } from './agent-session-restart-mounted'

/** Hidden replacement for a pane whose terminal is not open. Adopts only a verified resume. */
export async function spawnUnmountedAgentSessionRestart(
  startup: AgentSessionRestartStartup,
  pane: AgentSessionRestartPane
): Promise<AgentSessionRestartSpawnResult> {
  const state = useAppStore.getState()
  if (restartPaneOwner(state, pane.worktreeId, pane.tabId, pane.leafId) === 'missing') {
    return {}
  }
  if (!paneStillFenced(pane)) {
    return {}
  }
  const tab = state.tabsByWorktree[pane.worktreeId]?.find((item) => item.id === pane.tabId)
  const workspacePath = getWorkspacePath(state, pane.worktreeId)
  const cwd = tab?.startupCwd ?? workspacePath ?? undefined
  const capabilities = hasCachedWindowsTerminalCapabilities()
    ? getCachedWindowsTerminalCapabilities()
    : null
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, pane.worktreeId, undefined, {
    wslAvailable: capabilities?.wslAvailable,
    availableWslDistros: capabilities?.wslDistros ?? null
  })
  const paneOwner = restartPaneOwner(state, pane.worktreeId, pane.tabId, pane.leafId)
  const layout = state.terminalLayoutsByTabId[pane.tabId]
  const spawned = await window.api.pty.spawn({
    cols: 80,
    rows: 24,
    ...(cwd ? { cwd } : {}),
    command: startup.command,
    startupCommandDelivery: startup.startupCommandDelivery,
    launchAgent: startup.launchAgent,
    resumeProviderSession: startup.resumeProviderSession,
    resumeOnSelectedAccount: false,
    ...(startup.launchConfig ? { launchConfig: startup.launchConfig } : {}),
    env: {
      ...startup.env,
      ...buildPaneIdentityEnv(state, pane.worktreeId, pane.tabId, pane.leafId)
    },
    worktreeId: pane.worktreeId,
    tabId: pane.tabId,
    leafId: pane.leafId,
    replacesPtyId: pane.ptyId,
    ...(paneOwner === 'window' && replacesLayoutRoot(layout, pane.leafId)
      ? { placement: { kind: 'root' as const } }
      : {}),
    ...(tab?.shellOverride ? { shellOverride: tab.shellOverride } : {}),
    ...(projectRuntime ? { projectRuntime } : {}),
    initiallyHidden: true
  })
  const verdict = judgeAgentSessionRestartSpawn(startup.resumeProviderSession.id, spawned)
  if (!verdict.ok) {
    if (verdict.reapPtyId) {
      reapUnboundCodexPty(verdict.reapPtyId, 'session restart did not restore')
    }
    return spawned
  }
  if (!adoptUnmountedRestart(pane, verdict.ptyId)) {
    reapUnboundCodexPty(verdict.ptyId, 'session restart could not bind the pane')
    return { id: verdict.ptyId }
  }
  return spawned
}

export function spawnMountedAgentSessionRestart(
  startup: AgentSessionRestartStartup,
  pane: AgentSessionRestartPane
): Promise<AgentSessionRestartSpawnResult> {
  const restarter = getMountedAgentSessionRestart(pane.ptyId)
  if (!restarter) {
    return Promise.resolve({})
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: AgentSessionRestartSpawnResult | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (result?.refusedBeforeStop) {
        restoreUnstartedSessionRestartPane(pane)
        resolve(result)
        return
      }
      if (!result?.id || result.deferred) {
        resolve(result ?? {})
        return
      }
      const verdict = judgeAgentSessionRestartSpawn(startup.resumeProviderSession.id, result)
      if (!verdict.ok && verdict.reapPtyId) {
        reapUnboundCodexPty(verdict.reapPtyId, 'session restart did not restore')
        useAppStore.getState().clearTabPtyId(pane.tabId, verdict.reapPtyId)
      }
      resolve(result ?? {})
    }
    const accepted = restarter({
      command: startup.command,
      startupCommandDelivery: startup.startupCommandDelivery,
      launchAgent: startup.launchAgent,
      resumeProviderSession: startup.resumeProviderSession,
      resumeOnSelectedAccount: false,
      ...(startup.env ? { env: startup.env } : {}),
      ...(startup.launchConfig ? { launchConfig: startup.launchConfig } : {}),
      onSessionRestartSettled: finish
    })
    if (!accepted) {
      finish(null)
    }
  })
}

/**
 * Puts the old pty id back only after a pre-stop refusal.
 * A closed tab, a new generation, or a leaf another process owns stays as it is.
 */
export function restoreUnstartedSessionRestartPane(pane: AgentSessionRestartPane): boolean {
  const store = useAppStore.getState()
  const tab = store.tabsByWorktree[pane.worktreeId]?.find((item) => item.id === pane.tabId)
  if (!tab || (tab.generation ?? 0) !== pane.tabGeneration) {
    return false
  }
  const leafPty = store.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
  if (leafPty && leafPty !== pane.ptyId) {
    return false
  }
  const owners = store.ptyIdsByTabId[pane.tabId] ?? []
  if (owners.some((id) => id !== pane.ptyId)) {
    return false
  }
  if (!owners.includes(pane.ptyId)) {
    store.updateTabPtyId(pane.tabId, pane.ptyId)
  }
  if (leafPty !== pane.ptyId) {
    store.replaceTerminalLayoutPanePtyId(pane.tabId, pane.leafId, pane.ptyId)
  }
  return useAppStore.getState().ptyIdsByTabId[pane.tabId]?.includes(pane.ptyId) === true
}

function paneStillFenced(pane: AgentSessionRestartPane): boolean {
  const state = useAppStore.getState()
  const tab = state.tabsByWorktree[pane.worktreeId]?.find((item) => item.id === pane.tabId)
  return (
    !!tab &&
    (tab.generation ?? 0) === pane.tabGeneration &&
    (state.ptyIdsByTabId[pane.tabId] ?? []).includes(pane.ptyId) &&
    state.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId] === pane.ptyId
  )
}

function adoptUnmountedRestart(pane: AgentSessionRestartPane, newPtyId: string): boolean {
  const store = useAppStore.getState()
  const tab = store.tabsByWorktree[pane.worktreeId]?.find((item) => item.id === pane.tabId)
  if (!tab || (tab.generation ?? 0) !== pane.tabGeneration) {
    return false
  }
  const bound = store.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
  if (bound !== pane.ptyId && bound !== newPtyId) {
    return false
  }
  store.updateTabPtyId(pane.tabId, newPtyId, pane.ptyId)
  if (!useAppStore.getState().ptyIdsByTabId[pane.tabId]?.includes(newPtyId)) {
    return false
  }
  const owner = restartPaneOwner(store, pane.worktreeId, pane.tabId, pane.leafId)
  if (owner === 'window') {
    const layout = store.terminalLayoutsByTabId[pane.tabId]
    if (replacesLayoutRoot(layout, pane.leafId)) {
      store.setTabLayout(
        pane.tabId,
        singlePaneLayoutSnapshot(
          pane.leafId,
          newPtyId,
          layout?.titlesByLeafId?.[pane.leafId] ?? null
        )
      )
    } else {
      store.replaceTerminalLayoutPanePtyId(pane.tabId, pane.leafId, newPtyId)
    }
  }
  releaseReplacedCodexPanePty(pane.ptyId)
  return true
}

function replacesLayoutRoot(layout: TerminalLayoutSnapshot | undefined, leafId: string): boolean {
  return (
    !collectLeafIds(layout?.root).includes(leafId) &&
    Object.keys(layout?.ptyIdsByLeafId ?? {}).every((id) => id === leafId)
  )
}
