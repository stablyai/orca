/**
 * Identity for a rendered automation list row.
 *
 * An automation ID is unique only inside its authority, so under All hosts two
 * hosts can legitimately return `a-1` and every bare-ID map, React key, and
 * selection check silently collapses them into one. A row is therefore keyed by
 * the host it came from plus the record's ID.
 *
 * The host part is the incarnation-free `stableKey`, never `ownerKey`: this key
 * decides React identity and which row is selected, and both must survive a
 * re-pairing that bumps `pairingRevision` / `targetGeneration`. An
 * incarnation-bearing key would remount every row and drop the selection each
 * time a host reconnected. Freshness fences still use `ownerKey` — they are
 * asking a different question about the same row.
 */

import type { Automation } from '../../../../shared/automations-types'
import type { AutomationUsageSummary } from '../../../../shared/automation-usage-summary'
import { getAutomationRunRepoId } from '../../../../shared/automation-run-identity'
import type { StableAutomationCatalogRef } from '../../../../shared/automation-owner-ref'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

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

/**
 * Dedupe key for a record within one authority. Deliberately coarser than the
 * row key: an authority's Self, SSH, and orphan scopes can each return the same
 * record and only one should render, while two authorities holding that ID hold
 * two different records.
 */
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
  return repos.find((repo) => {
    const host = getRepoExecutionHostId(repo)
    return (
      repo.id === repoId &&
      (authority.kind === 'runtime'
        ? host === `runtime:${encodeURIComponent(authority.environmentId)}`
        : !host.startsWith('runtime:'))
    )
  })
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
