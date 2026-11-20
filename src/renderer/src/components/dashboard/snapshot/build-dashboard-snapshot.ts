import type { StructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import type { AppState } from '@/store/types'
import {
  DASHBOARD_MAX_MAP_WORKSPACES,
  type DashboardCard,
  type DashboardSnapshot,
  type DashboardWorkspace
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import type { RepoIcon } from '../../../../../shared/repository/appearance/repo-icon'
import type { DashboardCardTerminalInputState } from './dashboard-card-terminal-input'
import { readDashboardClientHost } from './dashboard-client-host'
import { selectTerminalLayoutsForWorktree } from '../../sidebar/workspace-card/activity/worktree-agent-row-selectors'
import { selectRuntimePaneTitlesForWorktree } from '../../sidebar/workspace-card/activity/worktree-card-status-inputs'
import {
  resolveDashboardCardContext,
  type DashboardCardContextState
} from './dashboard-card-context'
import {
  collectActiveDashboardWorkspaces,
  dashboardCardMapWorkspaceMetadata,
  type ActiveDashboardWorkspace
} from './dashboard-snapshot-workspaces'
import { boundedLabel } from './dashboard-card-labels'
import { buildDashboardSnapshotCard } from './dashboard-snapshot-card'
import { buildDashboardSnapshotFilterOptions } from './dashboard-snapshot-filter-options'
import { groupSubagentsByParentPaneKey } from './dashboard-subagent-cards'
import type { Translate } from '@/i18n/use-translate'
import { structuralValuesEqualIgnoringUndefined as equal } from '../../../../../shared/collections/structural-value-equality'
import {
  dashboardSnapshotReuseInputs,
  type DashboardSnapshotReuse,
  type DashboardWorkspaceBuild
} from './dashboard-snapshot-reuse'

/** Keep builder inputs as a Pick so tests need only construct the store slices read here. */
export type DashboardSnapshotState = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'tabsByWorktree'
  | 'agentStatusByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'runtimePaneTitlesByTabId'
  | 'acknowledgedAgentsByPaneKey'
  | 'settings'
> &
  DashboardCardContextState &
  Partial<
    DashboardCardTerminalInputState &
      Pick<
        AppState,
        | 'runtimeEnvironments'
        | 'sshTargetLabels'
        | 'unifiedTabsByWorktree'
        | 'activeWorktreeId'
        | 'activeWorkspaceExecutionHostId'
      >
  >

export type DashboardSnapshotInput = DashboardSnapshotState & { chatNames: StructuredChatTabNames }

/** Reuse sidebar row/index derivation for serializable cards; fold terminal-less subagents into their spawning card. */
export function buildDashboardSnapshot(
  state: DashboardSnapshotInput,
  now: number,
  options: {
    includeCardDetails?: boolean
    includeFilterOptions?: boolean
    reuse?: DashboardSnapshotReuse
  } = {},
  t?: Translate
): DashboardSnapshot {
  const reuse = options.reuse
  const projection = state.agentStatusByPaneKey.projection
  const clientHost = readDashboardClientHost()
  const inputs = [
    ...dashboardSnapshotReuseInputs(state),
    options.includeCardDetails,
    options.includeFilterOptions,
    t,
    clientHost.platform,
    clientHost.userAgent,
    clientHost.osRelease
  ]
  const statusOnly =
    reuse !== undefined &&
    reuse.projection === projection &&
    inputs.length === reuse.inputs.length &&
    inputs.every((value, index) => value === reuse.inputs[index])
  const changed = statusOnly ? projection.changesSince(reuse.cursor) : null
  const dirtyWorktrees = changed ? new Set<string>() : null
  for (const key of changed ?? []) {
    for (const worktreeId of reuse?.owners.get(key) ?? []) {
      dirtyWorktrees!.add(worktreeId)
    }
    const worktreeId = projection.rowWorktree(key)
    if (worktreeId) {
      dirtyWorktrees!.add(worktreeId)
    }
  }
  const cards: DashboardCard[] = []
  const workspaces: DashboardWorkspace[] | undefined =
    options.includeCardDetails === false ? undefined : []
  const repoIconsByRepoId: Record<string, RepoIcon | null> = {}
  const includeCardDetails = options.includeCardDetails !== false
  const showIdle = state.settings?.experimentalAgentDashboardShowIdle === true
  const activeWorktrees =
    dirtyWorktrees && reuse
      ? reuse.activeWorktrees
      : collectActiveDashboardWorkspaces(state, includeCardDetails)
  const nextWorkspaces = new Map<ActiveDashboardWorkspace, DashboardWorkspaceBuild>()
  const filterOptions =
    dirtyWorktrees && reuse
      ? reuse.filterOptions
      : options.includeFilterOptions === false
        ? undefined
        : buildDashboardSnapshotFilterOptions(state, activeWorktrees)

  for (const workspace of activeWorktrees) {
    const { repo, worktree } = workspace
    const worktreeId = worktree.id
    const parentWorktreeId = worktree.parentWorktreeId
    const previous = dirtyWorktrees ? reuse?.workspaces.get(workspace) : undefined
    if (previous && !dirtyWorktrees!.has(worktreeId)) {
      cards.push(...previous.cards)
      if (workspaces && previous.workspace && workspaces.length < DASHBOARD_MAX_MAP_WORKSPACES) {
        workspaces.push(previous.workspace)
      }
      if (previous.cards.length) {
        repoIconsByRepoId[workspace.projectId] = workspace.repoIcon
      }
      nextWorkspaces.set(workspace, previous)
      continue
    }
    const firstCard = cards.length
    const firstWorkspace = workspaces?.length ?? 0
    const nextRows: DashboardWorkspaceBuild['rows'] = new Map()
    const terminalLayoutsByTabId = selectTerminalLayoutsForWorktree(state, worktreeId)
    const paneTitlesByTabId = selectRuntimePaneTitlesForWorktree(state, worktreeId)

    const rows = state.agentStatusByPaneKey.projection.list(worktreeId)
    const subagentsByParentPaneKey = includeCardDetails
      ? groupSubagentsByParentPaneKey(rows)
      : undefined
    const context = previous
      ? previous.context
      : includeCardDetails
        ? resolveDashboardCardContext(state, repo, worktree, t)
        : undefined
    if (workspaces && workspaces.length < DASHBOARD_MAX_MAP_WORKSPACES) {
      const hostMetadata = dashboardCardMapWorkspaceMetadata(
        workspace,
        null,
        undefined,
        clientHost.platform
      )
      workspaces.push({
        repoId: workspace.projectId,
        worktreeId,
        repoName: boundedLabel(workspace.projectName),
        worktreeName: boundedLabel(worktree.displayName),
        ...(parentWorktreeId ? { parentWorktreeId } : {}),
        ...hostMetadata,
        workspaceStatusId: context?.workspaceStatus.id,
        workspaceStatusLabel: context?.workspaceStatus.label,
        workspaceStatusColor: context?.workspaceStatus.color,
        hasReview: context?.hasReview,
        review: context?.review
      })
    }

    for (const row of rows) {
      // Child rows have no pane of their own; the board lists top-level agents.
      if (row.rowSource === 'subagent') {
        continue
      }
      const prior = previous?.rows.get(row.paneKey)
      const status = state.agentStatusByPaneKey.get(row.paneKey)
      const activationStatus = row.activationPaneKey
        ? state.agentStatusByPaneKey.get(row.activationPaneKey)
        : undefined
      const children = subagentsByParentPaneKey?.get(row.paneKey)
      if (
        prior &&
        prior.row === row &&
        prior.status === status &&
        prior.activationStatus === activationStatus &&
        !changed?.has(row.paneKey) &&
        !changed?.has(row.activationPaneKey ?? '') &&
        equal(children, prior.card.subagents)
      ) {
        cards.push(prior.card)
        repoIconsByRepoId[workspace.projectId] = workspace.repoIcon
        nextRows.set(row.paneKey, prior)
        continue
      }
      const card = buildDashboardSnapshotCard({
        state,
        workspace,
        row,
        includeCardDetails,
        context,
        subagents: children,
        clientHost,
        terminalLayoutsByTabId,
        paneTitlesByTabId
      })
      repoIconsByRepoId[workspace.projectId] = workspace.repoIcon
      cards.push(card)
      nextRows.set(row.paneKey, { row, status, activationStatus, card })
    }
    nextWorkspaces.set(workspace, {
      cards: cards.slice(firstCard),
      rows: nextRows,
      context,
      workspace: workspaces && workspaces.length > firstWorkspace ? workspaces.at(-1) : undefined
    })
  }
  if (reuse) {
    if (!dirtyWorktrees) {
      reuse.owners.clear()
    } else {
      for (const worktreeId of dirtyWorktrees) {
        for (const workspace of reuse.workspacesById.get(worktreeId) ?? []) {
          for (const [key, row] of reuse.workspaces.get(workspace)?.rows ?? []) {
            for (const source of row.row.activationPaneKey
              ? [key, row.row.activationPaneKey]
              : [key]) {
              const owners = reuse.owners.get(source)
              owners?.delete(worktreeId)
              if (!owners?.size) {
                reuse.owners.delete(source)
              }
            }
          }
        }
      }
    }
    if (!dirtyWorktrees) {
      reuse.workspacesById.clear()
      for (const workspace of activeWorktrees) {
        const occurrences = reuse.workspacesById.get(workspace.worktree.id) ?? []
        occurrences.push(workspace)
        reuse.workspacesById.set(workspace.worktree.id, occurrences)
      }
    }
    for (const [workspace, built] of nextWorkspaces) {
      const worktreeId = workspace.worktree.id
      if (dirtyWorktrees && !dirtyWorktrees.has(worktreeId)) {
        continue
      }
      for (const [key, row] of built.rows) {
        for (const source of row.row.activationPaneKey ? [key, row.row.activationPaneKey] : [key]) {
          const owners = reuse.owners.get(source) ?? new Set<string>()
          owners.add(worktreeId)
          reuse.owners.set(source, owners)
        }
      }
    }
    reuse.inputs = inputs
    reuse.projection = projection
    reuse.cursor = projection.changeCursor()
    reuse.workspaces = nextWorkspaces
    reuse.activeWorktrees = activeWorktrees
    reuse.filterOptions = filterOptions
  }

  return {
    generatedAt: now,
    cards,
    ...(workspaces ? { workspaces } : {}),
    showIdle,
    filterOptions,
    repoIconsByRepoId
  }
}
