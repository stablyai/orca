import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { OrcadManagedPendingMigrationRow } from '../../../../shared/orcad-managed-runtime'
import {
  getOrcadSshDeployment,
  type PublicKnownRuntimeEnvironment
} from '../../../../shared/runtime-environments'
import type { SshTarget } from '../../../../shared/ssh-types'
import type { ManagedOrcadPreloadApi } from '../../../../preload/api/managed-orcad-api'
import { useMountedRef } from '@/hooks/useMountedRef'
import { isWebClientLocation } from '@/lib/web-client-location'
import { managedServerOutcomeLabel } from './managed-server-copy'

export type ManagedServerCatalog = {
  /** Absent in the web client, which can't reach SSH hosts. */
  api: ManagedOrcadPreloadApi | undefined
  targets: SshTarget[]
  /** SSH hosts that don't already run, or move to, a managed server. */
  emptyTargets: SshTarget[]
  pending: OrcadManagedPendingMigrationRow[]
  loadFailed: boolean
  resumingId: string | null
  reload: () => Promise<void>
  resume: (row: OrcadManagedPendingMigrationRow) => Promise<void>
}

/** Web fallback stubs cannot manage SSH hosts. */
export function getManagedOrcadApi(): ManagedOrcadPreloadApi | undefined {
  return isWebClientLocation() ? undefined : window.api.runtimeEnvironments.managedOrcad
}

export function useManagedServerCatalog(
  environments: PublicKnownRuntimeEnvironment[],
  onChanged: () => void
): ManagedServerCatalog {
  const api = getManagedOrcadApi()
  const mountedRef = useMountedRef()
  const [targets, setTargets] = useState<SshTarget[]>([])
  const [pending, setPending] = useState<OrcadManagedPendingMigrationRow[]>([])
  const [resumingId, setResumingId] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  const reload = useCallback(async () => {
    if (!api) {
      return
    }
    const [nextTargets, nextPending] = await Promise.all([
      window.api.ssh.listTargets(),
      api.listPendingMigrations()
    ])
    if (mountedRef.current) {
      setTargets(nextTargets)
      setPending(nextPending)
      setLoadFailed(false)
    }
  }, [api, mountedRef])

  useEffect(() => {
    void reload().catch(() => mountedRef.current && setLoadFailed(true))
  }, [mountedRef, reload])

  // Running or migrating servers already occupy the host.
  const busyTargetIds = new Set([
    ...environments.map((environment) => getOrcadSshDeployment(environment)?.sshTargetId),
    ...pending.map((row) => row.sshTargetId)
  ])
  const emptyTargets = targets.filter(
    (target) => !target.orcadFence && !busyTargetIds.has(target.id)
  )

  const resume = async (row: OrcadManagedPendingMigrationRow): Promise<void> => {
    if (!api || resumingId) {
      return
    }
    setResumingId(row.migrationId)
    try {
      const result = await api.convertSshHost({ sshTargetId: row.sshTargetId, name: row.name })
      if (result.outcome !== 'converted') {
        toast.message(managedServerOutcomeLabel(result))
      }
      onChanged()
      await reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      if (mountedRef.current) {
        setResumingId(null)
      }
    }
  }

  return { api, targets, emptyTargets, pending, loadFailed, resumingId, reload, resume }
}
