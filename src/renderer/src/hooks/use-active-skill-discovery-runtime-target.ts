import { useMemo } from 'react'
import { getSingleFocusedRuntimeEnvironmentId } from '@/lib/single-runtime-legacy-owner'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { useAppStore } from '@/store'

/** Distinguishes "not known yet" from "known to be the local host", without
 *  colliding with an environment id that happens to be named the same. */
const UNRESOLVED = Symbol('skill-discovery-runtime-unresolved')

/** Use install’s single-focused-runtime resolver so scan and install target the same proven host; ambiguous runtime ownership must not show misleading client-scan negatives (#6789). */
export function useActiveSkillDiscoveryRuntimeTarget(): RuntimeClientTarget | null {
  // Select resolved ID rather than input arrays so equal host refreshes cannot restart discovery scans.
  const ownerKey = useAppStore((state) => {
    // Wait for settled ownership before local caching; failed catalog reads may then degrade locally instead of leaving badges pending forever.
    if (!state.runtimeEnvironmentCatalogSettled) {
      return UNRESOLVED
    }
    const environmentId = getSingleFocusedRuntimeEnvironmentId(state)
    return environmentId
      ? formatOwnerKey(environmentId, getPairingRevision(state.runtimeEnvironments, environmentId))
      : null
  })
  return useMemo(
    () =>
      ownerKey === UNRESOLVED ? null : runtimeTargetForOwnerEnvironment(parseOwnerKey(ownerKey)),
    [ownerKey]
  )
}

// Include pairing revision: a same-ID new peer owns different disk and needs a fresh discovery target.
function formatOwnerKey(environmentId: string, pairingRevision: number | undefined): string {
  return `${pairingRevision ?? ''}:${environmentId}`
}

function parseOwnerKey(ownerKey: string | null): string | null {
  return ownerKey === null ? null : ownerKey.slice(ownerKey.indexOf(':') + 1)
}

function getPairingRevision(
  environments: readonly { id: string; createdAt: number; pairingRevision?: number }[],
  environmentId: string
): number | undefined {
  const environment = environments.find((entry) => entry.id === environmentId)
  return environment ? (environment.pairingRevision ?? environment.createdAt) : undefined
}
