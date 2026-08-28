import {
  clampExhaustedTiers,
  EMPTY_RETIRED_NAME_REGISTRY,
  type RetiredNameRegistry
} from './retired-name-registry'

/** Client-side caching rules for retired workspace names, shared by the desktop hook (IPC) and the
 *  mobile hook (RPC). The transports differ, but what a refresh and a failure *mean* must not: the
 *  two hooks drifted, and mobile's copy blanked the list on any error — which un-retires names and
 *  is the one outcome retirement exists to prevent.
 *
 *  Pure by construction: `src/shared` is on the main process's import graph, so no React here. */

/** The last answer, tagged with the repo it answered for. */
export type RetiredNamesLoad = {
  repoId: string
  registry: RetiredNameRegistry
}

/** Reads one repo's registry out of a `worktree.listRetiredNames` result. A host predating the
 *  method omits the field, and any host can answer with a malformed row that would throw when
 *  normalized.
 *
 *  `retiredNameTiersByRepo` is the compaction watermark and arrived after the names field. A host
 *  that omits it has simply never compacted; a client that ignored it would under-retire, which is
 *  the direction that degrades to the pre-retirement behavior rather than breaking. */
export function readRetiredNameRegistryForRepo(
  result: unknown,
  repoId: string
): RetiredNameRegistry {
  const row = result as
    | {
        retiredNamesByRepo?: Record<string, unknown>
        retiredNameTiersByRepo?: Record<string, unknown>
      }
    | null
    | undefined
  const names = row?.retiredNamesByRepo?.[repoId]
  return {
    exhaustedTiers: clampExhaustedTiers(row?.retiredNameTiersByRepo?.[repoId]),
    names: Array.isArray(names)
      ? names.filter((name): name is string => typeof name === 'string')
      : []
  }
}

/** Next state once a refresh settles; `registry === null` means it failed. Belongs in a `setState`
 *  updater rather than being applied at call time, so overlapping refreshes fold onto whatever
 *  actually landed last.
 *
 *  A failure holds the same repo's previous answer: a transient failure must not un-retire names,
 *  and a refresh fires on every workspace-list mutation, so blanking would suggest a spent name in
 *  exactly the window where the create form is asking for one. */
export function retiredNamesAfterRefresh(
  previous: RetiredNamesLoad | null,
  repoId: string,
  registry: RetiredNameRegistry | null
): RetiredNamesLoad {
  return {
    repoId,
    registry:
      registry ?? (previous?.repoId === repoId ? previous.registry : EMPTY_RETIRED_NAME_REGISTRY)
  }
}

/** Stale-while-revalidate view: a load answers only for its own repo, so names never leak across a
 *  repo switch, and a refetch in flight keeps serving the previous answer rather than emptying.
 *
 *  Returns the stored registry itself, not a copy, so it stays referentially stable and the
 *  suggestion memo downstream does not rerun on every refetch. */
export function selectRetiredNameRegistry(
  loaded: RetiredNamesLoad | null,
  repoId: string | null | undefined
): RetiredNameRegistry {
  return loaded && loaded.repoId === repoId ? loaded.registry : EMPTY_RETIRED_NAME_REGISTRY
}
