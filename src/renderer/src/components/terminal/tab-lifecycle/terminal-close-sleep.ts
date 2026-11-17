import { useAppStore } from '@/store/index'
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

function observedWorkspaceCanResume(
  state: AppState,
  worktreeId: string,
  tabs: ReadonlyMap<string, string[]>,
  busy: ReadonlySet<string>,
  candidates: ReadonlySet<string>
): boolean {
  const currentIds = new Set([...tabs.values()].flat())
  return (
    currentIds.size === candidates.size &&
    [...currentIds].every((id) => candidates.has(id)) &&
    [...tabs].every(([tabId, ptyIds]) => {
      const busyPtyIds = ptyIds.filter((id) => busy.has(id))
      return (
        busyPtyIds.length === 0 ||
        canSleepInsteadOfClosingTab(state, { worktreeId, terminalTabId: tabId, busyPtyIds })
      )
    })
  )
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
  const busy = new Set(
    probes.filter((probe) => probe.verdict === 'live').map((probe) => probe.ptyId)
  )
  if (
    busy.size === 0 ||
    !observedWorkspaceCanResume(state, worktreeId, current, busy, candidates)
  ) {
    return false
  }
  const idle = [...candidates].filter((id) => !busy.has(id))
  if (idle.length === 0) {
    return true
  }
  const finalIdle = await probePtyRunningWork(idle, {
    timeoutMs: RUNNING_CLOSE_PROBE_TIMEOUT_MS
  })
  if (
    finalIdle.length !== idle.length ||
    finalIdle.some((probe) => probe.timedOut || probe.verdict !== 'exited')
  ) {
    return false
  }
  const finalState = useAppStore.getState()
  return observedWorkspaceCanResume(
    finalState,
    worktreeId,
    workspaceTerminalPtys(finalState, worktreeId, terminalTabId),
    busy,
    candidates
  )
}
