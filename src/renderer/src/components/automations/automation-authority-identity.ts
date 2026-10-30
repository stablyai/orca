/** Read live pairing revisions/repo tables at use time; cached values can fence against a re-paired authority or a project that moved hosts. */

import type { Repo } from '../../../../shared/repo-types'
import type { LegacyAutomationPartitionContext } from '../../../../shared/automation-legacy-list-partition'
import type { StableAutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'

type RepoConnection = Pick<Repo, 'connectionId'>

export type AutomationAuthorityRepoTables = ReadonlyMap<string, ReadonlyMap<string, RepoConnection>>

/** Mirrors the authority's own rule: `undefined` = not in this table, `null` = local, string = SSH. */
export function repoConnectionIdIn(
  repoTable: ReadonlyMap<string, RepoConnection>
): (repoId: string) => string | null | undefined {
  return (repoId) => {
    const repo = repoTable.get(repoId)
    return repo ? repo.connectionId?.trim() || null : undefined
  }
}

const EMPTY_REPO_TABLE: ReadonlyMap<string, RepoConnection> = new Map()

function repoOwningAuthority(repo: Repo): StableAutomationAuthorityRef {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  // A desktop SSH repo is still desktop-stored; only a runtime host owns its own registry.
  return host?.kind === 'runtime'
    ? { kind: 'runtime', environmentId: host.environmentId }
    : { kind: 'desktop' }
}

/** Splits the flat repo list into one table per owning authority. */
export function groupReposByAutomationAuthority(
  repos: readonly Repo[]
): AutomationAuthorityRepoTables {
  const tables = new Map<string, Map<string, RepoConnection>>()
  for (const repo of repos) {
    const key = automationAuthorityCatalogKey(repoOwningAuthority(repo))
    let table = tables.get(key)
    if (!table) {
      table = new Map<string, RepoConnection>()
      tables.set(key, table)
    }
    table.set(repo.id, repo)
  }
  return tables
}

/** Only desktop repo misses prove absence. Runtime mirrors may lag or be empty, so stored rows stay unverified; colliding desktop IDs cannot answer for them. */
export function automationAuthorityPartitionContext(
  tables: AutomationAuthorityRepoTables,
  authority: StableAutomationAuthorityRef
): LegacyAutomationPartitionContext {
  return {
    repoConnectionId: repoConnectionIdIn(
      tables.get(automationAuthorityCatalogKey(authority)) ?? EMPTY_REPO_TABLE
    ),
    projectsAuthoritative: authority.kind === 'desktop'
  }
}

/** Read the saved runtime revision afresh to observe re-pairing; unknown environments return -1, which cannot match a real revision. */
export function automationRuntimePairingRevision(
  environments: readonly { id: string; createdAt: number; pairingRevision?: number }[],
  environmentId: string
): number {
  const environment = environments.find((candidate) => candidate.id === environmentId)
  return environment ? (environment.pairingRevision ?? environment.createdAt) : -1
}
