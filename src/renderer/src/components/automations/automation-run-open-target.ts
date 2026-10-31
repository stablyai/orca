import type { AutomationRun } from '../../../../shared/automations-types'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  parseRemoteRuntimePtyId,
  isRemoteRuntimePtyId
} from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  isWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from '../../../../shared/terminal-surface-id'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { terminalLayoutContainsLeaf } from '../../../../shared/workspace-session-pane-ownership'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { AutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import type { AppState } from '@/store/types'
import {
  getFolderWorkspaceWorktree,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'
import { resolveExactWorktreeRoute } from '@/lib/worktree-owner-route'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getAutomationRunViewState } from './automation-run-view-state'
import { resolveOwner } from '@/lib/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import { resolveQualifiedFolderWorkspaceResult } from '../../../../shared/folder-workspace-execution-host'
import { getRuntimeEnvironmentIdForFolderWorkspace } from '@/lib/folder-workspace-runtime-owner'

export type AutomationRunPaneTarget = {
  tabId: string
  paneKey: string
  leafId: string
  /** Null while a hibernated run pane waits for its tab to wake it. */
  ptyId: string | null
}

function getAutomationRunOpenTabId(run: Pick<AutomationRun, 'terminalPaneKey'>): string | null {
  return parsePaneKey(run.terminalPaneKey ?? '')?.tabId ?? null
}

export function automationRunMatchesPaneKey(
  run: Pick<AutomationRun, 'terminalPaneKey'>,
  paneKey: string
): boolean {
  return run.terminalPaneKey ? paneKey === run.terminalPaneKey : false
}

export function resolveAutomationRunOpenTarget({
  run,
  terminalTabExists,
  currentLayout,
  livePtyIds
}: {
  run: AutomationRun
  terminalTabExists: boolean
  currentLayout: TerminalLayoutSnapshot | null | undefined
  livePtyIds: readonly string[]
}): AutomationRunPaneTarget | null {
  const parsed = parsePaneKey(run.terminalPaneKey ?? '')
  if (!terminalTabExists || !parsed || !currentLayout?.root) {
    return null
  }
  if (!terminalLayoutContainsLeaf(currentLayout.root, parsed.leafId)) {
    return null
  }
  const layoutPtyId = currentLayout.ptyIdsByLeafId?.[parsed.leafId]
  if (!run.terminalPtyId) {
    // Why: a slept run pane keeps its key but drops its PTY id; the pane, not a process, is the target.
    return {
      tabId: parsed.tabId,
      paneKey: run.terminalPaneKey!,
      leafId: parsed.leafId,
      ptyId: layoutPtyId && livePtyIds.includes(layoutPtyId) ? layoutPtyId : null
    }
  }
  if (!livePtyIds.includes(run.terminalPtyId)) {
    return null
  }
  if (layoutPtyId !== undefined && layoutPtyId !== run.terminalPtyId) {
    return null
  }
  return {
    tabId: parsed.tabId,
    paneKey: run.terminalPaneKey!,
    leafId: parsed.leafId,
    ptyId: run.terminalPtyId
  }
}

export type AutomationRunTerminalState = {
  hasTerminalTab: (tabId: string) => boolean
  terminalLayoutsByTabId: Readonly<Record<string, TerminalLayoutSnapshot | undefined>>
  ptyIdsByTabId: Readonly<Record<string, readonly string[] | undefined>>
}

/** Paired runs name server tab/pane/PTY identities; local mirrors use server terminal handles, so require a PTY from that server instead of comparing its internal PTY ID. */
export function resolveAutomationRunTerminalTarget(
  run: AutomationRun,
  terminals: AutomationRunTerminalState,
  ownerEnvironmentId: string | null
): AutomationRunPaneTarget | null {
  const tabId = getAutomationRunOpenTabId(run)
  if (!tabId) {
    return null
  }
  const local = resolveAutomationRunOpenTarget({
    run,
    terminalTabExists: terminals.hasTerminalTab(tabId),
    currentLayout: terminals.terminalLayoutsByTabId[tabId],
    livePtyIds: terminals.ptyIdsByTabId[tabId] ?? []
  })
  const parsed = parsePaneKey(run.terminalPaneKey ?? '')
  if (local || !ownerEnvironmentId || !parsed || isWebTerminalSurfaceTabId(tabId)) {
    return local
  }
  const mirroredTabId = toWebTerminalSurfaceTabId(tabId)
  const layout = terminals.terminalLayoutsByTabId[mirroredTabId]
  const mirroredPtyId = layout?.ptyIdsByLeafId?.[parsed.leafId]
  // Why a live PTY only: a slept run's pane is asked of the server, which knows if it still exists.
  if (
    !run.terminalPtyId ||
    !terminals.hasTerminalTab(mirroredTabId) ||
    !layout?.root ||
    !mirroredPtyId ||
    !terminalLayoutContainsLeaf(layout.root, parsed.leafId) ||
    parseRemoteRuntimePtyId(mirroredPtyId)?.environmentId !== ownerEnvironmentId ||
    !(terminals.ptyIdsByTabId[mirroredTabId] ?? []).includes(mirroredPtyId)
  ) {
    return null
  }
  return {
    tabId: mirroredTabId,
    paneKey: makePaneKey(mirroredTabId, parsed.leafId),
    leafId: parsed.leafId,
    ptyId: mirroredPtyId
  }
}

export { buildAutomationRunOpenLayout } from './automation-run-pane-layout'

/** The paired server that owns the run's workspace, or null when this client runs it itself. */
export function getAutomationRunOwnerEnvironmentId(
  state: WorktreeOperationRouteState,
  workspaceId: string | null | undefined,
  hostId?: ExecutionHostId
): string | null {
  if (!workspaceId) {
    return null
  }
  const owner = resolveOwner(state, { workspaceId, ...(hostId ? { hostId } : {}) })
  return owner.kind === 'resolved' && owner.owner.endpoint.kind === 'environment'
    ? owner.owner.endpoint.environmentId
    : null
}

/** Historical physical ownership comes from the acquired namespace and recorded pane, never today's definition. */
export function resolveAutomationRunTarget(
  state: Pick<
    AppState,
    | 'repos'
    | 'worktreesByRepo'
    | 'folderWorkspaces'
    | 'unifiedTabsByWorktree'
    | 'tabsByWorktree'
    | 'terminalLayoutsByTabId'
    | 'ptyIdsByTabId'
    | 'runtimeEnvironments'
    | 'projectGroups'
    | 'settings'
  >,
  run: AutomationRun,
  authority: AutomationAuthorityRef | null
) {
  const environmentId = authority?.kind === 'runtime' ? authority.environmentId : null
  const environment = state.runtimeEnvironments.find((entry) => entry.id === environmentId)
  const fresh =
    authority?.kind !== 'runtime' ||
    (environment &&
      (environment.pairingRevision ?? environment.createdAt) === authority.pairingRevision)
  const contextHost =
    run.runContext?.hostId === 'local' && environmentId
      ? toRuntimeExecutionHostId(environmentId)
      : parseExecutionHostId(run.runContext?.hostId)?.id
  const folder = parseWorkspaceKey(run.workspaceId ?? '')?.type === 'folder'
  const candidates = fresh
    ? [
        ...Object.values(selectWorktreesByRepo(state)).flat(),
        ...selectFolderWorkspaces(state).flatMap((workspace) => {
          const result = resolveQualifiedFolderWorkspaceResult(
            { ...state, folderWorkspaces: [workspace] },
            workspace.id
          )
          return result.kind === 'selected'
            ? [getFolderWorkspaceWorktree(workspace, result.value)]
            : []
        })
      ]
        .filter((row) => row.id === run.workspaceId)
        .flatMap((row) => {
          const repos = state.repos.filter((repo) => repo.id === row.repoId)
          const hostId =
            parseExecutionHostId(row.hostId)?.id ??
            (repos.length === 1 ? getRepoExecutionHostId(repos[0]) : null)
          if (!hostId) {
            return []
          }
          const worktree = row.hostId === hostId ? row : { ...row, hostId }
          const scope = parseWorkspaceKey(row.id)
          const route =
            scope?.type === 'folder'
              ? {
                  kind: 'resolved' as const,
                  route: {
                    executionHostId: hostId,
                    runtimeEnvironmentId: getRuntimeEnvironmentIdForFolderWorkspace(
                      state,
                      scope.folderWorkspaceId,
                      hostId
                    )
                  }
                }
              : resolveExactWorktreeRoute(state, worktree)
          if (
            route.kind !== 'resolved' ||
            (environmentId && route.route.runtimeEnvironmentId !== environmentId) ||
            (authority?.kind === 'desktop' && hostId.startsWith('runtime:'))
          ) {
            return []
          }
          const ownerEnvironmentId = route.route.runtimeEnvironmentId
          const tabs = state.unifiedTabsByWorktree[row.id] ?? []
          const terminalTarget = resolveAutomationRunTerminalTarget(
            run,
            {
              hasTerminalTab: (tabId) => {
                const stamped = tabs.filter(
                  (tab) => tab.contentType === 'terminal' && tab.entityId === tabId
                )
                const legacy =
                  stamped.length === 0 && !ownerEnvironmentId
                    ? (state.tabsByWorktree[row.id] ?? [])
                        .filter((tab) => tab.id === tabId)
                        .map((tab) => ({
                          ...tab,
                          entityId: tab.id,
                          executionHostId: undefined,
                          contentType: 'terminal'
                        }))
                    : []
                return [...stamped, ...legacy].some((tab) => {
                  if (
                    tab.contentType !== 'terminal' ||
                    tab.entityId !== tabId ||
                    tab.worktreeId !== row.id ||
                    (tab.executionHostId && tab.executionHostId !== hostId) ||
                    (!tab.executionHostId && !folder && contextHost && contextHost !== hostId)
                  ) {
                    return false
                  }
                  const pane = parsePaneKey(run.terminalPaneKey ?? '')
                  const ptyId =
                    (pane
                      ? state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[pane.leafId]
                      : null) ?? run.terminalPtyId
                  if (ptyId && isRemoteRuntimePtyId(ptyId)) {
                    return (
                      !!ownerEnvironmentId &&
                      parseRemoteRuntimePtyId(ptyId)?.environmentId === ownerEnvironmentId
                    )
                  }
                  return !ownerEnvironmentId || tab.executionHostId === hostId
                })
              },
              terminalLayoutsByTabId: state.terminalLayoutsByTabId,
              ptyIdsByTabId: state.ptyIdsByTabId
            },
            ownerEnvironmentId
          )
          return [{ worktree, ownerEnvironmentId, terminalTarget }]
        })
    : []
  const exact = candidates.filter((candidate) => candidate.terminalTarget)
  const historical = candidates.filter(
    (candidate) => folder || !contextHost || candidate.worktree.hostId === contextHost
  )
  const matches = exact.length ? exact : historical
  const target = matches.length === 1 ? matches[0] : null
  // The serving host can verify its recorded pane before this client's catalogs arrive.
  const ownerOnly =
    fresh &&
    environmentId &&
    run.workspaceId &&
    parsePaneKey(run.terminalPaneKey ?? '') &&
    run.terminalPtyId
  return {
    worktree: target?.worktree ?? null,
    ownerEnvironmentId: target?.ownerEnvironmentId ?? (ownerOnly ? environmentId : null),
    expectedPairingRevision: authority?.kind === 'runtime' ? authority.pairingRevision : undefined,
    terminalTarget: target?.terminalTarget ?? null,
    viewState: getAutomationRunViewState({
      run,
      workspaceExists: !!target || !!ownerOnly,
      terminalTargetExists: !!target?.terminalTarget,
      terminalOnPairedServer: !!target?.ownerEnvironmentId || !!ownerOnly
    })
  }
}
