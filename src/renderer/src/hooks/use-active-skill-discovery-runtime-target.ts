import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getSingleFocusedRuntimeEnvironmentId } from '@/lib/single-runtime-legacy-owner'
import { getActiveRuntimeTarget, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'

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
  const owner = useAppStore(
    useShallow((state) => ({
      activeRuntimeEnvironmentId: state.settings?.activeRuntimeEnvironmentId ?? null,
      catalogHydrated: state.runtimeEnvironmentCatalogHydrated,
      runtimeEnvironments: state.runtimeEnvironments,
      settingsHydrated: state.settings !== null
    }))
  )
  return useMemo(() => {
    // Why: falling back to "local" before hydration caches a client scan under the
    // local key and flashes "Not installed" at a user whose skills live remotely.
    if (!owner.settingsHydrated || !owner.catalogHydrated) {
      return null
    }
    return getActiveRuntimeTarget({
      activeRuntimeEnvironmentId: getSingleFocusedRuntimeEnvironmentId({
        settings: { activeRuntimeEnvironmentId: owner.activeRuntimeEnvironmentId },
        runtimeEnvironments: owner.runtimeEnvironments
      })
    })
  }, [owner])
}
