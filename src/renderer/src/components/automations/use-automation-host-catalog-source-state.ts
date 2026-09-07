import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type {
  AutomationCatalogRuntimeSource,
  AutomationCatalogSshSource,
  AutomationHostCatalogSource
} from './automation-host-catalog-source'

/**
 * Reads the mirrored SSH and runtime state the catalog projects from.
 *
 * Split out of `use-automation-host-catalog` so the store subscriptions stay in
 * one place: every map here is a live store reference whose identity changes on
 * each write, and the catalog memo below depends on all of them.
 */

type AutomationHostCatalogSourceStateInput = {
  /** Desktop SSH registration generations, mirrored by the store alongside the maps below. */
  desktopSshGenerations: ReadonlyMap<string, number>
  runtimeEnvironments: readonly PublicKnownRuntimeEnvironment[]
}

export type AutomationHostCatalogSourceState = Pick<
  AutomationHostCatalogSource,
  'desktopSsh' | 'runtimes' | 'runtimeCatalogSettled'
>

export function useAutomationHostCatalogSourceState({
  desktopSshGenerations,
  runtimeEnvironments
}: AutomationHostCatalogSourceStateInput): AutomationHostCatalogSourceState {
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const removedSshTargetLabels = useAppStore((s) => s.removedSshTargetLabels)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const sshTargetsHydrated = useAppStore((s) => s.sshTargetsHydrated)
  const sshStateByEnvironment = useAppStore((s) => s.sshStateByEnvironment)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const runtimeCatalogSettled = useAppStore((s) => s.runtimeEnvironmentCatalogSettled)

  const desktopSsh = useMemo(
    (): AutomationCatalogSshSource => ({
      targetsHydrated: sshTargetsHydrated,
      targetLabels: sshTargetLabels,
      targetGenerations: desktopSshGenerations,
      removedTargetLabels: removedSshTargetLabels,
      connectionStates: sshConnectionStates
    }),
    [
      desktopSshGenerations,
      removedSshTargetLabels,
      sshConnectionStates,
      sshTargetLabels,
      sshTargetsHydrated
    ]
  )

  const runtimes = useMemo(
    (): AutomationCatalogRuntimeSource[] =>
      runtimeEnvironments.map((environment) => {
        const bucket = sshStateByEnvironment.get(environment.id)
        const status = runtimeStatusByEnvironmentId.get(environment.id)
        return {
          environmentId: environment.id,
          label: environment.name,
          // Mirrors the owner ref's own rule: creation time stands in until the
          // server reports a revision, so a re-pair still changes the value.
          pairingRevision: environment.pairingRevision ?? environment.createdAt,
          status: status ? { status: status.status } : undefined,
          ssh: bucket
            ? {
                targetsHydrated: bucket.targetsHydrated,
                targetLabels: bucket.targetLabels,
                targetGenerations: bucket.targetGenerations,
                removedTargetLabels: bucket.removedTargetLabels,
                connectionStates: bucket.connectionStates
              }
            : undefined
        }
      }),
    [runtimeEnvironments, runtimeStatusByEnvironmentId, sshStateByEnvironment]
  )

  // Memoized: consumers key whole-catalog rebuilds on this object's identity.
  return useMemo(
    () => ({ desktopSsh, runtimes, runtimeCatalogSettled }),
    [desktopSsh, runtimes, runtimeCatalogSettled]
  )
}
