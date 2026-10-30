/** Qualify row IDs by incarnation-free host stableKey so colliding authorities stay distinct and re-pairs preserve React identity/selection. Freshness uses incarnation-bearing ownerKey separately. */

import type { Automation } from '../../../../shared/automations-types'
import type { AutomationUsageSummary } from '../../../../shared/automation-usage-summary'
import { getAutomationRunRepoId } from '../../../../shared/automation-run-identity'
import type { StableAutomationCatalogRef } from '../../../../shared/automation-owner-ref'
import {
  getConnectionExecutionHostId,
  getRepoExecutionHostId,
  getWorktreeExecutionHostId
} from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getFolderWorkspaceWorktree } from '../../store/slices/worktrees/listing/detected-worktree-meta'

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
  repos: readonly Repo[],
  fallback: ReadonlyMap<string, Repo>
): Repo | undefined {
  const repoId = getAutomationRunRepoId(row.automation)
  const authority = row.catalogRef?.authority
  if (!authority) {
    return fallback.get(repoId)
  }
  return repos.find(
    (repo) => repo.id === repoId && authorityOwnsHost(authority, getRepoExecutionHostId(repo))
  )
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
  workspaceId: string | null | undefined = row.automation.workspaceId
): Worktree | undefined {
  const scope = workspaceId ? parseWorkspaceKey(workspaceId) : null
  if (scope?.type !== 'folder') {
    return undefined
  }
  const authority = row.catalogRef?.authority
  const matches = folderWorkspaces.filter(
    (workspace) =>
      workspace.id === scope.folderWorkspaceId &&
      (!authority ||
        authorityOwnsHost(
          authority,
          workspace.executionHostId ?? getConnectionExecutionHostId(workspace.connectionId)
        ))
  )
  return matches.length === 1 ? getFolderWorkspaceWorktree(matches[0]) : undefined
}

export function automationWorktreeForRow(
  row: AutomationListRow,
  worktreesByRepo: Readonly<Record<string, readonly Worktree[]>>,
  repo: Repo | undefined,
  fallback: ReadonlyMap<string, Worktree>,
  workspaceId: string | null | undefined = row.automation.workspaceId
): Worktree | undefined {
  if (!workspaceId || !row.catalogRef || !repo) {
    return workspaceId ? fallback.get(workspaceId) : undefined
  }
  const hostId = getRepoExecutionHostId(repo)
  return Object.values(worktreesByRepo)
    .flat()
    .find(
      (worktree) =>
        worktree.id === workspaceId && getWorktreeExecutionHostId(worktree, repo) === hostId
    )
}
