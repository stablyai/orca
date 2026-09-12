import { useRef, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeEnvironmentReconciliationRequest } from '../../../../shared/runtime-environment-reconciliation-request'

export function useRuntimeEnvironmentReconciliation() {
  const mounted = useMountedRef()
  const pending = useRef(false)
  const fresh = useRef(false)
  const [environments, setEnvironments] = useState<PublicKnownRuntimeEnvironment[]>([])
  const [busy, setBusy] = useState(false)
  const [snapshotFresh, setSnapshotFresh] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  const run = async (request?: RuntimeEnvironmentReconciliationRequest): Promise<void> => {
    if (pending.current || (request && !fresh.current) || !mounted.current) {
      return
    }
    pending.current = true
    fresh.current = false
    setBusy(true)
    setSnapshotFresh(false)
    setRequestError(null)
    setRefreshError(null)
    try {
      if (request) {
        try {
          await window.api.runtimeEnvironments.reconcile(request)
        } catch (error) {
          if (mounted.current) {
            setRequestError(extractIpcErrorMessage(error, String(error)))
          }
        }
      }
      // A lost reply can follow publication; only a registry reread determines the saved stage.
      const next = await window.api.runtimeEnvironments.list()
      useAppStore.getState().setRuntimeEnvironments(next)
      fresh.current = true
      if (mounted.current) {
        setEnvironments(next)
        setSnapshotFresh(true)
      }
    } catch (error) {
      if (mounted.current) {
        setRefreshError(extractIpcErrorMessage(error, String(error)))
      }
    } finally {
      pending.current = false
      if (mounted.current) {
        setBusy(false)
      }
    }
  }

  return {
    environments,
    busy,
    snapshotFresh,
    requestError,
    refreshError,
    refresh: () => run(),
    reconcile: (request: RuntimeEnvironmentReconciliationRequest) => run(request)
  }
}
