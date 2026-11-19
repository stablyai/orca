import {
  selectWorktreesByRepo,
  selectFolderWorkspaces,
  selectDetectedWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import {
  eligibleCodexRestartPtyIds,
  coveredCodexRestartPtyIds,
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

type RestartProjection = {
  inputs: CodexRestartStatusSummaryInput
  panes?: ReturnType<typeof currentCodexRestartPanes>
  tabs?: ReturnType<typeof codexRestartTabIndex>
  queuedPaneKeys: ReadonlySet<string>
  coveredPtyIds: ReadonlySet<string>
  summary: CodexRestartStatusSummary
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const key of left) {
    if (!right.has(key)) {
      return false
    }
  }
  return true
}

function projectCodexRestartStatus(
  state: CodexRestartStatusSummaryInput,
  previous?: RestartProjection
): RestartProjection {
  const inputs: CodexRestartStatusSummaryInput = {
    repos: state.repos,
    worktreesByRepo: selectWorktreesByRepo(state),
    detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
    folderWorkspaces: selectFolderWorkspaces(state),
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
    pendingPaneAccountRestarts: state.pendingPaneAccountRestarts,
    codexRestartNoticeByPtyId: state.codexRestartNoticeByPtyId
  }
  const queuedPaneKeys = new Set<string>()
  const requests: CodexAccountRestart[] = []
  for (const [key, request] of Object.entries(state.pendingPaneAccountRestarts ?? {})) {
    if (isCodexAccountRestart(request)) {
      queuedPaneKeys.add(key)
      requests.push(request)
    }
  }
  if (requests.length === 0 && Object.keys(state.codexRestartNoticeByPtyId).length === 0) {
    return { inputs, queuedPaneKeys, coveredPtyIds: new Set(), summary: EMPTY }
  }
  const sameTopology =
    previous?.inputs.tabsByWorktree === state.tabsByWorktree &&
    previous.inputs.terminalLayoutsByTabId === state.terminalLayoutsByTabId &&
    previous.inputs.ptyIdsByTabId === state.ptyIdsByTabId
  const panes = (sameTopology && previous.panes) || currentCodexRestartPanes(state)
  const tabs =
    (sameTopology && previous.tabs) || (requests.length ? codexRestartTabIndex(state) : undefined)
  // Currency stays live at each queued scope; phases reuse the global topology, not owner answers.
  const currentRequests = requests.filter((r) => isCurrentCodexAccountRestart(state, r, tabs))
  const coveredPtyIds = coveredCodexRestartPtyIds(currentRequests)
  const failures = currentRequests.filter((r) => ['failed', 'unresolved'].includes(r.phase))
  const stalePtyIds =
    sameTopology &&
    previous.inputs.codexRestartNoticeByPtyId === state.codexRestartNoticeByPtyId &&
    sameSet(previous.queuedPaneKeys, queuedPaneKeys) &&
    sameSet(previous.coveredPtyIds, coveredPtyIds)
      ? previous.summary.stalePtyIds
      : eligibleCodexRestartPtyIds(state, panes, currentRequests)
  const unchanged =
    previous?.summary.stalePtyIds === stalePtyIds &&
    previous.summary.failures.length === failures.length &&
    failures.every((request, index) => previous.summary.failures[index] === request)
  const summary = unchanged
    ? previous.summary
    : {
        stalePtyIds,
        staleSessionCount: stalePtyIds.length,
        failures,
        attentionCount: stalePtyIds.length + failures.length
      }
  return { inputs, panes, tabs, queuedPaneKeys, coveredPtyIds, summary }
}

export function summarizeCodexRestartStatus(
  state: CodexRestartStatusSummaryInput
): CodexRestartStatusSummary {
  return projectCodexRestartStatus(state).summary
}

let projection: RestartProjection | undefined
export function selectCodexRestartStatus(
  state: CodexRestartStatusSummaryInput
): CodexRestartStatusSummary {
  const previous = projection?.inputs
  if (
    !previous ||
    previous.codexRestartNoticeByPtyId !== state.codexRestartNoticeByPtyId ||
    previous.pendingPaneAccountRestarts !== state.pendingPaneAccountRestarts ||
    previous.ptyIdsByTabId !== state.ptyIdsByTabId ||
    previous.tabsByWorktree !== state.tabsByWorktree ||
    previous.terminalLayoutsByTabId !== state.terminalLayoutsByTabId ||
    previous.repos !== state.repos ||
    selectWorktreesByRepo(previous) !== selectWorktreesByRepo(state) ||
    selectDetectedWorktreesByRepo(previous) !== selectDetectedWorktreesByRepo(state) ||
    selectFolderWorkspaces(previous) !== selectFolderWorkspaces(state) ||
    previous.projectGroups !== state.projectGroups ||
    previous.restoredRuntimeHostIdByWorkspaceSessionKey !==
      state.restoredRuntimeHostIdByWorkspaceSessionKey ||
    previous.activeWorktreeId !== state.activeWorktreeId ||
    previous.activeWorkspaceExecutionHostId !== state.activeWorkspaceExecutionHostId ||
    previous.runtimeEnvironments !== state.runtimeEnvironments ||
    previous.runtimeEnvironmentCatalogHydrated !== state.runtimeEnvironmentCatalogHydrated ||
    previous.removedRuntimeEnvironmentIds !== state.removedRuntimeEnvironmentIds
  ) {
    projection = projectCodexRestartStatus(state, projection)
  }
  return projection?.summary ?? EMPTY
}
export function selectCodexStaleSessionCount(state: CodexRestartStatusSummaryInput): number {
  return selectCodexRestartStatus(state).attentionCount
}
