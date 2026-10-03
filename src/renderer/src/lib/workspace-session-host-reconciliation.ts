import type { Repo } from '../../../shared/repo-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  createRepoRowExecutionHostLookup,
  resolveWorktreeExecutionHost
} from '../../../shared/worktree-execution-host-resolution'
import { workspaceIdsNamedByPartition } from '../../../shared/workspace-session-stranded-partition-adoption'

export type SshPartitionCatalogAttribution = {
  contestedSessionKeys: Set<string>
  foreignSessionKeysByHostId: Map<ExecutionHostId, Set<string>>
  /** Ids the catalog positively, currently resolves to exactly that host — the GAP-03 signal
   *  `reconciledWorktreeIdsForHost` is built from once migration residue elsewhere is ruled out. */
  confirmedSessionKeysByHostId: Map<ExecutionHostId, Set<string>>
}

/** A worktree session key names its repo before `::`; a folder key names no repo at all. */
function isWorktreeSessionKey(workspaceId: string): boolean {
  return workspaceId.includes('::')
}

/** Ids that appear in more than one of these per-partition sets. */
function sessionKeysHeldByMultiplePartitionSets(sets: readonly ReadonlySet<string>[]): Set<string> {
  const held = new Set<string>()
  const contested = new Set<string>()
  for (const keys of sets) {
    for (const key of keys) {
      if (held.has(key)) {
        contested.add(key)
      }
      held.add(key)
    }
  }
  return contested
}

/**
 * What the repo catalog says about the workspaces each SSH partition names.
 *
 * `contested` — "one workspace written twice" is false, so adoption may gap-fill but never replace.
 * Three sources, none of which is bare co-presence in 'local' and `ssh:<targetId>`; that pair IS the
 * shape the repair exists for, and reading it as a collision disables the repair:
 *  - the local/runtime rivalry the contention split already arbitrated;
 *  - two SSH partitions both naming the id, which that split never sees;
 *  - a repo id the catalog registers on more than one host.
 *
 * `foreign` — the catalog positively resolves the id to a different host. That is residue, not a
 * rival claim: adopting it would show a stale row in front of the live one and then route it into
 * the live partition. The same "positively says otherwise" rule `catalogReattributedAwayFrom` uses
 * — an id the catalog cannot speak for is neither contested nor foreign, so a boot whose repos have
 * not hydrated still reunites its rows.
 *
 * `confirmed` — the catalog positively resolves the id to EXACTLY this host, via the row's own
 * `executionHostId` field (not a bare `connectionId` fallback). See `reconciledWorktreeIdsForHost`.
 */
export function sshPartitionCatalogAttribution(
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[],
  sshPartitions: readonly (readonly [ExecutionHostId, WorkspaceSessionState | null])[],
  mergedContested: ReadonlySet<string>
): SshPartitionCatalogAttribution {
  const contestedSessionKeys = new Set(mergedContested)
  const foreignSessionKeysByHostId = new Map<ExecutionHostId, Set<string>>()
  const confirmedSessionKeysByHostId = new Map<ExecutionHostId, Set<string>>()
  const repoLookup = createRepoRowExecutionHostLookup(repos)
  const ownedByHostId = new Map<ExecutionHostId, Set<string>>()
  for (const [hostId, slice] of sshPartitions) {
    if (!slice) {
      continue
    }
    const foreign = new Set<string>()
    const owned = new Set<string>()
    const confirmed = new Set<string>()
    for (const workspaceId of workspaceIdsNamedByPartition(slice)) {
      // A folder key carries no repo id at all, and `getRepoIdFromWorktreeId` hands back the whole
      // key rather than nothing, so the catalog would be asked about `folder:<uuid>` and answer
      // `unknown`. Right verdict, wasted resolution; skip it by shape instead.
      const resolution = isWorktreeSessionKey(workspaceId)
        ? resolveWorktreeExecutionHost(repoLookup, {
            repoId: getRepoIdFromWorktreeId(workspaceId),
            hostId: null
          })
        : null
      if (resolution?.kind === 'resolved' && resolution.hostId !== hostId) {
        foreign.add(workspaceId)
        continue
      }
      if (resolution?.kind === 'unresolved' && resolution.reason === 'ambiguous') {
        contestedSessionKeys.add(workspaceId)
      }
      // GAP-03's `confirmed` reading is deliberately narrower than `resolution.hostId === hostId`:
      // that verdict already treats a bare `connectionId` (no `executionHostId` on the row) as
      // resolved, which is exactly the pre-#12723 catalog shape this repair's "one-shot" gap-fill
      // exists for. Requiring the row's OWN `executionHostId` field keeps that legacy shape on the
      // unconditional path and reserves the stricter "empty base row means zero" reading for a
      // catalog that has actually recorded this repo's current host.
      if (
        resolution?.kind === 'resolved' &&
        resolution.hostId === hostId &&
        normalizeExecutionHostId(resolution.owner?.executionHostId ?? null) === hostId
      ) {
        confirmed.add(workspaceId)
      }
      owned.add(workspaceId)
    }
    if (foreign.size > 0) {
      foreignSessionKeysByHostId.set(hostId, foreign)
    }
    if (confirmed.size > 0) {
      confirmedSessionKeysByHostId.set(hostId, confirmed)
    }
    ownedByHostId.set(hostId, owned)
  }
  // Why co-presence is asked only of the ids left after the catalog has spoken: one partition
  // holding residue the catalog attributes elsewhere is a single owner plus a leftover, not a
  // collision. Counting the leftover would withhold the real owner's rows from the write.
  for (const workspaceId of sessionKeysHeldByMultiplePartitionSets([...ownedByHostId.values()])) {
    contestedSessionKeys.add(workspaceId)
  }
  return { contestedSessionKeys, foreignSessionKeysByHostId, confirmedSessionKeysByHostId }
}

/**
 * Keys this partition must not contribute: the ones the catalog gave to another host, plus a
 * contested id the assembled session holds no row for at all.
 *
 * Why the second class: a contested id is withheld from the read-source override, so the write
 * re-derives an owner — and for an id the catalog cannot name, that answer is 'local'. Adopting
 * such a row would move it out of the partition that owns it and into the blob, which is the
 * two-store split this whole change removes. Gap-filling stays available for a contested id the
 * session already has a row for, because that row's own partition is what the write follows.
 * Declining to adopt leaks a row into invisibility for one boot; it never deletes one.
 */
export function unownedSessionKeys(
  session: WorkspaceSessionState,
  contestedSessionKeys: ReadonlySet<string>,
  foreignSessionKeys: ReadonlySet<string> | undefined
): ReadonlySet<string> {
  if (contestedSessionKeys.size === 0) {
    return foreignSessionKeys ?? new Set<string>()
  }
  const unowned = new Set(foreignSessionKeys ?? [])
  const known = workspaceIdsNamedByPartition(session)
  for (const key of contestedSessionKeys) {
    if (!known.has(normalizeWorkspaceSessionKeyToWorkspaceId(key))) {
      unowned.add(key)
    }
  }
  return unowned
}

/** Ids the catalog marks foreign for ANY host: demonstrably held residue on more than one
 *  partition, i.e. a migration rather than a plain reconnect. `reconciledWorktreeIdsForHost`
 *  withholds these so a freshly-moved connection's real, live tabs still adopt normally. */
function migratedSessionKeys(attribution: SshPartitionCatalogAttribution): Set<string> {
  const migrated = new Set<string>()
  for (const foreign of attribution.foreignSessionKeysByHostId.values()) {
    for (const workspaceId of foreign) {
      migrated.add(workspaceId)
    }
  }
  return migrated
}

/**
 * GAP-03 (stablyai/orca#22038 / revive_labs#962): worktree ids to pass as
 * `adoptStrandedHostPartitionSession`'s `reconciledWorktreeIds` for `hostId` — the catalog
 * confirms this host owns them, and no sibling partition holds foreign residue proving a
 * migration. See `sshPartitionCatalogAttribution` and that option's own docs for the full
 * reasoning.
 *
 * `wasConnectedAtLastShutdown` gates the whole result on whether THIS host's SSH target was
 * actually connected when the client last quit (`activeConnectionIdsAtShutdown`, read from the
 * base session before this host's slice is merged in). GAP-03's own bug requires the client to
 * have been disconnected from the host while the server closed tabs — an absent base row for an
 * SSH-routed worktree is never evidence of anything by itself (that data is never routed to the
 * base partition at all, closed or not), so it only becomes trustworthy as "the server's current
 * truth of zero" once a genuine offline gap has actually happened. A client that quit while still
 * connected wrote the host partition's mirror itself, moments earlier, as its OWN live state, not
 * a leftover cache — treating that boot identically to a real reconnect-after-offline mistook an
 * ordinary restart for one, and declined (dropped) every still-open tab on every SSH worktree
 * whose repo carries the modern `executionHostId` stamp (`remote-repo-registration.ts` sets this
 * on every SSH repo it registers) on literally every quit+relaunch, closed or not.
 */
export function reconciledWorktreeIdsForHost(
  attribution: SshPartitionCatalogAttribution,
  hostId: ExecutionHostId,
  wasConnectedAtLastShutdown: boolean
): Set<string> {
  if (wasConnectedAtLastShutdown) {
    return new Set()
  }
  const reconciled = new Set(attribution.confirmedSessionKeysByHostId.get(hostId))
  for (const workspaceId of migratedSessionKeys(attribution)) {
    reconciled.delete(workspaceId)
  }
  return reconciled
}
