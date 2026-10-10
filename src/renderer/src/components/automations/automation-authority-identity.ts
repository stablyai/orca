/**
 * The two live values an authority's fence is keyed by, read from mirrored store
 * state rather than remembered.
 *
 * Both answer the same question — which incarnation is this authority right
 * now — and both must be read at the moment of use: a cached pairing revision
 * survives a re-pair, and a cached repo table survives a repo moving hosts, so
 * either one held too long fences a request against an authority that is gone.
 */

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

/**
 * The legacy partition context for the authority that answered.
 *
 * Only the desktop table is a verdict. A runtime's repos reach this client as a
 * mirror that is populated on connect and can lag or be empty, so a miss there
 * leaves the record unverified instead of declaring its project gone — and a
 * desktop repo that happens to share an ID never gets to answer for it.
 */
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

/**
 * The revision the runtime transport guard compares, read from the saved
 * environment list so a re-pair is observed rather than cached. An unknown
 * environment answers -1, which never matches a real revision.
 */
export function automationRuntimePairingRevision(
  environments: readonly { id: string; createdAt: number; pairingRevision?: number }[],
  environmentId: string
): number {
  const environment = environments.find((candidate) => candidate.id === environmentId)
  return environment ? (environment.pairingRevision ?? environment.createdAt) : -1
}
