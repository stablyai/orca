/** Qualify row IDs by incarnation-free host stableKey so colliding authorities stay distinct and re-pairs preserve React identity/selection. Freshness uses incarnation-bearing ownerKey separately. */

import type { Automation } from '../../../../shared/automations-types'
import type { AutomationUsageSummary } from '../../../../shared/automation-usage-summary'
import { findAutomationRepo } from '../../../../shared/automation-repo-target'
import { getAutomationRunRepoId } from '../../../../shared/automation-run-identity'
import type { StableAutomationCatalogRef } from '../../../../shared/automation-owner-ref'
import {
  getRepoExecutionHostId,
  getConnectionExecutionHostId,
  getRepoSshConnectionId,
  toSshExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import {
  resolveQualifiedFolderWorkspaceResult,
  type QualifiedFolderHostState
} from '../../../../shared/folder-workspace-execution-host'
import {
  createRepoRowExecutionHostLookup,
  resolveWorktreeExecutionHost
} from '../../../../shared/worktree-execution-host-resolution'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getFolderWorkspaceWorktree } from '../../store/workspace-record-selectors'

export type AutomationListRow = {
  /** Authority-qualified and incarnation-free; see the module note. */
  key: string
  automation: Automation
  /** Storage authority captured with the host query; absent only for the bootstrap list. */
  catalogRef?: StableAutomationCatalogRef | null
  /** The host this row actually came from; empty for unscoped legacy rows. */
  hostLabel: string
  /** What the owning authority reported; null means unknown, never zero. */
  usageSummary: AutomationUsageSummary | null
}

const ROW_KEY_NAMESPACE = 'row'
/** The pre-catalog list has no host to qualify with, so it says so rather than guessing one. */
const UNSCOPED_HOST_KEY = 'unscoped'

export function automationListRowKey(hostStableKey: string | null, automationId: string): string {
  return [ROW_KEY_NAMESPACE, hostStableKey ?? UNSCOPED_HOST_KEY, automationId]
    .map(encodeURIComponent)
    .join('|')
}

/** Deduplicate Self/SSH/orphan copies within one authority; matching IDs on different authorities remain distinct records. */
export function automationAuthorityRecordKey(authorityKey: string, automationId: string): string {
  return [authorityKey, automationId].map(encodeURIComponent).join('|')
}

/** The unscoped list the page shows before any host has answered. */
export function unscopedAutomationListRows(
  automations: readonly Automation[]
): AutomationListRow[] {
  return automations.map((automation) => ({
    key: automationListRowKey(null, automation.id),
    automation,
    catalogRef: null,
    hostLabel: '',
    usageSummary: null
  }))
}

export function automationRepoForRow(
  row: AutomationListRow,
  repos: readonly Repo[]
): Repo | undefined {
  const repoId = getAutomationRunRepoId(row.automation)
  const authority = row.catalogRef?.authority
  if (!authority) {
    return findAutomationRepo(repos, repoId, row.automation.runContext)
  }
  const context = row.automation.runContext
  const owned = repos.filter((repo) => authorityOwnsHost(authority, getRepoExecutionHostId(repo)))
  if (authority.kind !== 'runtime') {
    return findAutomationRepo(owned, repoId, context)
  }
  const hostId =
    context?.hostId === toRuntimeExecutionHostId(authority.environmentId)
      ? 'local'
      : context?.hostId
  const matches = owned.filter(
    (repo) =>
      repo.id === repoId &&
      (!context ||
        (repo.path === context.path &&
          (getRepoSshConnectionId(repo)
            ? toSshExecutionHostId(getRepoSshConnectionId(repo)!)
            : 'local') === hostId))
  )
  return matches.length === 1 ? matches[0] : undefined
}

function authorityOwnsHost(
  authority: StableAutomationCatalogRef['authority'],
  hostId: string
): boolean {
  return authority.kind === 'runtime'
    ? hostId === `runtime:${encodeURIComponent(authority.environmentId)}`
    : !hostId.startsWith('runtime:')
}

/** Folder workspaces are not in `worktreesByRepo`; dispatch resolves `folder:<id>` the same way. */
export function automationFolderWorktreeForRow(
  row: AutomationListRow,
  folderWorkspaces: readonly FolderWorkspace[],
  workspaceId: string | null | undefined = row.automation.workspaceId,
  catalog?: QualifiedFolderHostState
): Worktree | undefined {
  const scope = workspaceId ? parseWorkspaceKey(workspaceId) : null
  if (scope?.type !== 'folder') {
    return undefined
  }
  const authority = row.catalogRef?.authority
  if (!catalog) {
    const rows = folderWorkspaces.filter(
      (workspace) =>
        workspace.id === scope.folderWorkspaceId &&
        (!authority ||
          authorityOwnsHost(
            authority,
            workspace.executionHostId ?? getConnectionExecutionHostId(workspace.connectionId)
          ))
    )
    return rows.length === 1 ? getFolderWorkspaceWorktree(rows[0]) : undefined
  }
  const matches = folderWorkspaces.flatMap((workspace) => {
    const result = resolveQualifiedFolderWorkspaceResult(
      { ...catalog, folderWorkspaces: [workspace] },
      scope.folderWorkspaceId
    )
    return result.kind === 'selected' &&
      (!authority || authorityOwnsHost(authority, result.value.hostId))
      ? [getFolderWorkspaceWorktree(workspace, result.value)]
      : []
  })
  return matches.length === 1 ? matches[0] : undefined
}

export function automationWorktreesForRepo(
  worktrees: readonly Worktree[],
  repo: Repo,
  repos: readonly Repo[]
): Worktree[] {
  const hostId = getRepoExecutionHostId(repo)
  const host = parseExecutionHostId(hostId)
  const lookup = createRepoRowExecutionHostLookup(repos)
  return worktrees.filter((worktree) => {
    if (worktree.repoId !== repo.id) {
      return false
    }
    const owner = resolveWorktreeExecutionHost(lookup, worktree)
    if (host?.kind === 'runtime') {
      const legacyOwner =
        !worktree.hostId && !worktree.runtimeOwnerEnvironmentId && owner.kind === 'resolved'
          ? owner
          : null
      return (
        (worktree.runtimeOwnerEnvironmentId === host.environmentId ||
          worktree.hostId === hostId ||
          legacyOwner?.hostId === hostId) &&
        (worktree.hostId === hostId
          ? 'local'
          : (worktree.hostId ??
            (legacyOwner?.connectionId
              ? toSshExecutionHostId(legacyOwner.connectionId)
              : 'local'))) ===
          (getRepoSshConnectionId(repo)
            ? toSshExecutionHostId(getRepoSshConnectionId(repo)!)
            : 'local')
      )
    }
    return (
      !worktree.runtimeOwnerEnvironmentId && owner.kind === 'resolved' && owner.hostId === hostId
    )
  })
}

export function automationWorktreeForRow(
  row: AutomationListRow,
  worktreesByRepo: Readonly<Record<string, readonly Worktree[]>>,
  repo: Repo | undefined,
  repos: readonly Repo[],
  workspaceId: string | null | undefined = row.automation.workspaceId
): Worktree | undefined {
  if (!workspaceId || !repo) {
    return undefined
  }
  const matches = automationWorktreesForRepo(worktreesByRepo[repo.id] ?? [], repo, repos).filter(
    (worktree) => worktree.id === workspaceId
  )
  return matches.length === 1 ? matches[0] : undefined
}
