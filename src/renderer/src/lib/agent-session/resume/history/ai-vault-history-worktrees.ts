import type { AppState } from '@/store/types'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo,
  selectFolderWorkspaces
} from '@/store/workspaces/catalog/workspace-record-fields'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import {
  findFirstIndexedWorktree,
  findIndexedDetectedWorktrees
} from '@/lib/workspace/ownership/worktree-runtime-owner-index'
import { resolveQualifiedWorktreeExecutionOwner } from '@/lib/workspace/ownership/qualified-worktree-execution-owner'
import { selectWorkspaceByHostTarget } from '@/store/workspaces/selection/workspace-host-target'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  normalizeExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  areRuntimePathsEqual,
  isLegacyRepoForExternalWorktreeVisibility,
  shouldShowWorktree
} from '../../../../../../shared/worktree/ownership'
import { createRepoRowExecutionHostLookup } from '../../../../../../shared/execution-host/worktree-execution-host-resolution'
import type { Repo } from '../../../../../../shared/repo-types'
import type {
  DetectedWorktree,
  DetectedWorktreeListSource,
  Worktree
} from '../../../../../../shared/worktree/types'

export type AiVaultHistoryWorktreeState = Pick<AppState, 'worktreesByRepo'> &
  Partial<
    Pick<
      AppState,
      | 'detectedWorktreesByRepo'
      | 'folderWorkspaces'
      | 'projectGroups'
      | 'repos'
      | 'settings'
      | 'floatingWorkspacePath'
    >
  >

const emptyDetected: AppState['detectedWorktreesByRepo'] = {}
const emptyWorktrees: AppState['worktreesByRepo'] = {}
const emptyRepos: AppState['repos'] = []
const emptyFolders: AppState['folderWorkspaces'] = []
const emptyGroups: AppState['projectGroups'] = []

export type AiVaultHistoryVisibilitySettings = Pick<
  NonNullable<AppState['settings']>,
  'worktreeVisibilityDefaults'
> | null

function historyWorktreeWasVisible(
  state: { settings: AiVaultHistoryVisibilitySettings },
  worktree: DetectedWorktree,
  repo: Repo | null,
  source: DetectedWorktreeListSource
): boolean {
  if (!repo) {
    return false
  }
  if (
    !state.settings ||
    (source === 'metadata-fallback' &&
      worktree.ownership !== 'agent-scratch' &&
      !worktree.visibilitySource)
  ) {
    return true
  }
  // History keeps the prior policy inputs; checkout eligibility only controls new choices.
  return shouldShowWorktree({
    worktree: { path: worktree.path },
    ownership: worktree.ownership,
    repo,
    isLegacyRepoForVisibility: isLegacyRepoForExternalWorktreeVisibility(repo),
    isSelectedCheckout: areRuntimePathsEqual(worktree.path, repo.path),
    importedExternalWorktreePaths: repo.importedExternalWorktreePaths,
    visibilityDefaults: state.settings.worktreeVisibilityDefaults,
    visibilitySource: worktree.visibilitySource ?? null
  })
}

/** History-only matcher/scope input, never a workspace destination list. */
export function aiVaultHistoryWorktrees(
  visible: readonly Worktree[],
  state: Pick<AppState, 'detectedWorktreesByRepo' | 'repos'> & {
    settings: AiVaultHistoryVisibilitySettings
  }
): readonly Worktree[] {
  return collectHistoryWorktrees(visible, state, (worktree) => worktree.isBare)
}

/** Current metadata can own an existing record without offering a new workspace. */
export function aiVaultHistoryRecordWorktrees(
  visible: readonly Worktree[],
  state: Parameters<typeof aiVaultHistoryWorktrees>[1],
  include: (worktree: DetectedWorktree) => boolean
): readonly Worktree[] {
  return collectHistoryWorktrees(visible, state, include)
}

function collectHistoryWorktrees(
  visible: readonly Worktree[],
  state: Parameters<typeof aiVaultHistoryWorktrees>[1],
  include: (worktree: DetectedWorktree) => boolean
): readonly Worktree[] {
  let result: Worktree[] | undefined
  const repos = createRepoRowExecutionHostLookup(state.repos ?? emptyRepos)
  const address = (row: Worktree): string =>
    JSON.stringify([row.id, row.hostId ?? null, row.runtimeOwnerEnvironmentId ?? null])
  const visibleRows = new Set(visible.map(address))
  for (const listing of Object.values(selectDetectedWorktreesByRepo(state) ?? emptyDetected)) {
    for (const worktree of listing.worktrees) {
      if (!include(worktree) || visibleRows.has(address(worktree))) {
        continue
      }
      const host = worktree.runtimeOwnerEnvironmentId
        ? toRuntimeExecutionHostId(worktree.runtimeOwnerEnvironmentId)
        : normalizeExecutionHostId(worktree.hostId)
      const repoMatch = repos.byId(worktree.repoId)
      const repo =
        (host ? repos.byHost(worktree.repoId, host) : null) ??
        (repoMatch.kind === 'resolved' ? repoMatch.owner : null)
      if (historyWorktreeWasVisible(state, worktree, repo, listing.source)) {
        result ??= [...visible]
        result.push(worktree)
        visibleRows.add(address(worktree))
      }
    }
  }
  return result ?? visible
}

/** Resolve the saved record's address without making hidden discoveries new destinations. */
export function findAiVaultHistoryWorktree(
  state: AiVaultHistoryWorktreeState,
  worktreeId: string,
  executionHostId?: ExecutionHostId | null
): Worktree | undefined {
  const hostId = normalizeExecutionHostId(executionHostId)
  const detectedWorktreesByRepo = selectDetectedWorktreesByRepo(state) ?? emptyDetected
  const records = {
    worktreesByRepo: selectWorktreesByRepo(state),
    detectedWorktreesByRepo,
    folderWorkspaces: selectFolderWorkspaces(state) ?? emptyFolders,
    projectGroups: state.projectGroups ?? emptyGroups,
    repos: state.repos ?? emptyRepos,
    floatingWorkspacePath: state.floatingWorkspacePath ?? null
  }
  const visible = findFirstIndexedWorktree(selectWorktreesByRepo(state), worktreeId)
  if (!hostId) {
    return visible
  }
  const qualified = selectWorkspaceByHostTarget(
    records,
    hostWorktreeTarget({ id: worktreeId, hostId })
  )
  if (qualified) {
    return qualified
  }
  const rows = findIndexedDetectedWorktrees(detectedWorktreesByRepo, worktreeId)
  const owner = resolveQualifiedWorktreeExecutionOwner(
    { [worktreeId]: rows },
    records.repos,
    worktreeId,
    hostId
  )
  if (!owner) {
    return visible
  }
  // Directory lookup uses the transport owner; the record's execution host was qualified above.
  const directoryHost = owner.worktree.runtimeOwnerEnvironmentId
    ? toRuntimeExecutionHostId(owner.worktree.runtimeOwnerEnvironmentId)
    : (owner.worktree.hostId ?? 'local')
  const known = findKnownWorktreeById(
    { ...records, worktreesByRepo: emptyWorktrees },
    worktreeId,
    directoryHost
  )
  // Preserve the ordinary visible-row mismatch check without substituting a raw twin.
  return known === owner.worktree ? known : visible
}
