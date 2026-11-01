import {
  clampExhaustedTiers,
  EMPTY_RETIRED_NAME_REGISTRY,
  type RetiredNameRegistry
} from './retired-name-registry'

/** Desktop IPC and mobile RPC share cache semantics: refresh failure must never un-retire names. Keep this shared import graph free of React. */

/** The last answer, tagged with the repo it answered for. */
export type RetiredNamesLoad = {
  repoId: string
  registry: RetiredNameRegistry
}

/** Read legacy/malformed host results defensively. Missing tiers means no compaction; ignoring a supplied watermark would incorrectly un-retire compacted names. */
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

/** Apply through a state updater so overlapping refreshes fold onto the latest state. Failure retains the same repo’s answer; blanking it could suggest a spent name. */
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

/** Serve a stable previous registry during refetch, only for its own repo; never leak names across repo switches. */
export function selectRetiredNameRegistry(
  loaded: RetiredNamesLoad | null,
  repoId: string | null | undefined
): RetiredNameRegistry {
  return loaded && loaded.repoId === repoId ? loaded.registry : EMPTY_RETIRED_NAME_REGISTRY
}
