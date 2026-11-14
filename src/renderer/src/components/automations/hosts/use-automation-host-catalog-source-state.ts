import { useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { getPairedWebClientEnvironmentId } from '@/app-shell/platform/paired-web-client-host'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { getManagedOrcadSshTargetId } from '../../../../../shared/execution-host/managed-orcad-execution-host'
import type {
  AutomationCatalogRuntimeSource,
  AutomationCatalogSshSource,
  AutomationHostCatalogSource
} from './automation-host-catalog-source'

/** Centralize live mirrored SSH/runtime subscriptions whose reference identities drive catalog memoization. */

type AutomationHostCatalogSourceStateInput = {
  /** Desktop SSH registration generations, mirrored by the store alongside the maps below. */
  desktopSshGenerations: ReadonlyMap<string, number>
  runtimeEnvironments: readonly PublicKnownRuntimeEnvironment[]
}

export type AutomationHostCatalogSourceState = Pick<
  AutomationHostCatalogSource,
  'desktopSsh' | 'runtimes' | 'desktopAliasEnvironmentId' | 'runtimeCatalogSettled'
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
        const managedSshTargetId = getManagedOrcadSshTargetId(environment)
        return {
          environmentId: environment.id,
          label: environment.name,
          // Use creation time until a pairing revision exists, matching owner refs so re-pairs still change identity.
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
            : undefined,
          ...(managedSshTargetId ? { managedSshTargetId } : {})
        }
      }),
    [runtimeEnvironments, runtimeStatusByEnvironmentId, sshStateByEnvironment]
  )

  // A web client's local calls are its paired server's, so Desktop and that runtime are one authority.
  const desktopAliasEnvironmentId = getPairedWebClientEnvironmentId({ runtimeEnvironments })

  // Memoized: consumers key whole-catalog rebuilds on this object's identity.
  return useMemo(
    () => ({ desktopSsh, runtimes, desktopAliasEnvironmentId, runtimeCatalogSettled }),
    [desktopSsh, runtimes, desktopAliasEnvironmentId, runtimeCatalogSettled]
  )
}
