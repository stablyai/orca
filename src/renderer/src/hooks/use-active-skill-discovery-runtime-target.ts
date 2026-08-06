import { useMemo } from 'react'
import { getSingleFocusedRuntimeEnvironmentId } from '@/lib/single-runtime-legacy-owner'
import { getActiveRuntimeTarget, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'

/** Distinguishes "not known yet" from "known to be the local host", without
 *  colliding with an environment id that happens to be named the same. */
const UNRESOLVED = Symbol('skill-discovery-runtime-unresolved')

/**
 * Runtime that owns skill discovery, or `null` while the store still cannot say.
 *
 * Resolved through `getSingleFocusedRuntimeEnvironmentId` rather than raw
 * `activeRuntimeEnvironmentId` on purpose: the skill *install* terminal routes
 * through that same resolver (`terminal-worktree-route.ts`), which declines to
 * guess an owner while several runtimes are saved. Scanning a host the install
 * cannot reach would leave the badge stuck on "Not installed" forever — #6789
 * again, just inverted. Scan and install must always name the same host.
 */
export function useActiveSkillDiscoveryRuntimeTarget(): RuntimeClientTarget | null {
  // Why: select the resolved id (a string) rather than its inputs. Selecting
  // `runtimeEnvironments` would churn identity every time a status refresh
  // restores an equal-but-new array, re-firing every consumer's scan.
  const environmentId = useAppStore((state) =>
    // Why: resolving to "local" before the catalog settles caches a client scan
    // under the local key and flashes "Not installed" at a user whose skills live
    // remotely. Settled rather than hydrated, so a failed catalog read degrades to
    // the local host instead of leaving every badge pending for the session.
    state.runtimeEnvironmentCatalogSettled
      ? getSingleFocusedRuntimeEnvironmentId(state)
      : UNRESOLVED
  )
  return useMemo(
    () =>
      environmentId === UNRESOLVED
        ? null
        : getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId }),
    [environmentId]
  )
}
