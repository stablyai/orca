import {
  eligibleCodexRestartPtyIds,
  codexRestartTabIndex,
  currentCodexRestartPanes,
  isCodexAccountRestart,
  isCurrentCodexAccountRestart,
  type CodexRestartPopulationState
} from '@/store/terminals/codex-account-restart-continuation'
import type { CodexAccountRestart } from '@/store/terminals/terminal-contracts'

export type CodexRestartStatusSummaryInput = CodexRestartPopulationState
export type CodexRestartStatusSummary = {
  stalePtyIds: string[]
  staleSessionCount: number
  failures: CodexAccountRestart[]
  attentionCount: number
}
const EMPTY: CodexRestartStatusSummary = {
  stalePtyIds: [],
  staleSessionCount: 0,
  failures: [],
  attentionCount: 0
}

export function summarizeCodexRestartStatus(
  state: CodexRestartStatusSummaryInput
): CodexRestartStatusSummary {
  const requests = Object.values(state.paneAccountRestarts ?? {}).filter(isCodexAccountRestart)
  if (requests.length === 0 && Object.keys(state.codexRestartNoticeByPtyId).length === 0) {
    return EMPTY
  }
  const panes = currentCodexRestartPanes(state)
  const tabs = requests.length > 0 ? codexRestartTabIndex(state) : undefined
  const failures = requests.filter(
    (r) =>
      ['failed', 'unresolved'].includes(r.phase) && isCurrentCodexAccountRestart(state, r, tabs)
  )
  const stalePtyIds = eligibleCodexRestartPtyIds(state, panes)
  return {
    stalePtyIds,
    staleSessionCount: stalePtyIds.length,
    failures,
    attentionCount: stalePtyIds.length + failures.length
  }
}
let previous: CodexRestartStatusSummaryInput | undefined
let summary = EMPTY
export function selectCodexRestartStatus(
  state: CodexRestartStatusSummaryInput
): CodexRestartStatusSummary {
  if (
    !previous ||
    previous.codexRestartNoticeByPtyId !== state.codexRestartNoticeByPtyId ||
    previous.paneAccountRestarts !== state.paneAccountRestarts ||
    previous.ptyIdsByTabId !== state.ptyIdsByTabId ||
    previous.tabsByWorktree !== state.tabsByWorktree ||
    previous.terminalLayoutsByTabId !== state.terminalLayoutsByTabId ||
    previous.repos !== state.repos ||
    previous.worktreesByRepo !== state.worktreesByRepo ||
    previous.detectedWorktreesByRepo !== state.detectedWorktreesByRepo ||
    previous.folderWorkspaces !== state.folderWorkspaces ||
    previous.projectGroups !== state.projectGroups ||
    previous.restoredRuntimeHostIdByWorkspaceSessionKey !==
      state.restoredRuntimeHostIdByWorkspaceSessionKey ||
    previous.activeWorktreeId !== state.activeWorktreeId ||
    previous.activeWorkspaceExecutionHostId !== state.activeWorkspaceExecutionHostId ||
    previous.runtimeEnvironments !== state.runtimeEnvironments ||
    previous.runtimeEnvironmentCatalogHydrated !== state.runtimeEnvironmentCatalogHydrated ||
    previous.removedRuntimeEnvironmentIds !== state.removedRuntimeEnvironmentIds
  ) {
    previous = {
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo,
      detectedWorktreesByRepo: state.detectedWorktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
      activeWorktreeId: state.activeWorktreeId,
      activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
      runtimeEnvironments: state.runtimeEnvironments,
      runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
      removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds,
      tabsByWorktree: state.tabsByWorktree,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId,
      ptyIdsByTabId: state.ptyIdsByTabId,
      paneAccountRestarts: state.paneAccountRestarts,
      codexRestartNoticeByPtyId: state.codexRestartNoticeByPtyId
    }
    summary = summarizeCodexRestartStatus(state)
  }
  return summary
}
export function selectCodexStaleSessionCount(state: CodexRestartStatusSummaryInput): number {
  return selectCodexRestartStatus(state).attentionCount
}
