import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { collectTabPtyIds, RUNNING_CLOSE_PROBE_TIMEOUT_MS } from './running-terminal-close-guard'
import { probePtyRunningWork } from './pty-running-work-probe'
import { canSleepInsteadOfClosingTab } from './terminal-close-sleep-eligibility'

function workspaceTerminalPtys(state: AppState, worktreeId: string, terminalTabId: string) {
  const tabIds = new Set([
    terminalTabId,
    ...(state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
  ])
  for (const tab of state.unifiedTabsByWorktree[worktreeId] ?? []) {
    if (tab.contentType === 'terminal') {
      tabIds.add(tab.entityId)
    }
  }
  return new Map([...tabIds].map((tabId) => [tabId, collectTabPtyIds(state, tabId)]))
}

/** Recheck every observed workspace terminal before the alternate action stops the workspace. */
export async function revalidateTerminalCloseSleep(
  worktreeId: string,
  terminalTabId: string
): Promise<boolean> {
  const before = workspaceTerminalPtys(useAppStore.getState(), worktreeId, terminalTabId)
  const candidates = new Set([...before.values()].flat())
  if (candidates.size === 0) {
    return false
  }
  const probes = await probePtyRunningWork([...candidates], {
    timeoutMs: RUNNING_CLOSE_PROBE_TIMEOUT_MS
  })
  if (probes.some((probe) => probe.timedOut || probe.verdict === 'unverifiable')) {
    return false
  }
  const state = useAppStore.getState()
  const current = workspaceTerminalPtys(state, worktreeId, terminalTabId)
  const currentIds = new Set([...current.values()].flat())
  if (currentIds.size !== candidates.size || [...currentIds].some((id) => !candidates.has(id))) {
    return false
  }
  const busy = new Set(
    probes.filter((probe) => probe.verdict === 'live').map((probe) => probe.ptyId)
  )
  if (busy.size === 0) {
    return false
  }
  return [...current].every(([tabId, ptyIds]) => {
    const busyPtyIds = ptyIds.filter((id) => busy.has(id))
    return (
      busyPtyIds.length === 0 ||
      canSleepInsteadOfClosingTab(state, { worktreeId, terminalTabId: tabId, busyPtyIds })
    )
  })
}
