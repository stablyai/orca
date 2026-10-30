import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  ORCAD_RECOVERY_CHANGED_STATE_CODE,
  ORCAD_UPDATE_TERMINALS_RUNNING_CODE,
  type OrcadManagedDeferral,
  type OrcadManagedPastLiveTerminals,
  type OrcadManagedRuntimeStatus
} from '../../../../shared/orcad-managed-runtime'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { ManagedOrcadPreloadApi } from '../../../../preload/api/managed-orcad-api'
import { useMountedRef } from '@/hooks/useMountedRef'
import { managedServerOutcomeLabel } from './managed-server-copy'

export type ManagedServerAction =
  | 'update'
  | 'forceUpdate'
  | 'rollback'
  | 'recover'
  | 'restoreSnapshot'
  | 'stop'
  | 'cancelStop'
  | 'forget'

export type ManagedServerLifecycle = {
  status: OrcadManagedRuntimeStatus | null
  statusError: string | null
  recovery: OrcadManagedRuntimeStatus['recovery']
  busy: ManagedServerAction | 'status' | null
  confirmingStop: boolean
  confirmingForget: boolean
  confirmingRestore: boolean
  /** An Update deferred only by running terminals, which Update anyway restarts past. */
  confirmingForceUpdate: OrcadManagedPastLiveTerminals | null
  setConfirmingForceUpdate: (value: OrcadManagedPastLiveTerminals | null) => void
  setConfirmingStop: (value: boolean) => void
  setConfirmingForget: (value: boolean) => void
  setConfirmingRestore: (value: boolean) => void
  loadStatus: () => Promise<void>
  run: (action: ManagedServerAction) => Promise<void>
}

function isLiveTerminalsDeferral(result: { outcome: string } | OrcadManagedDeferral): boolean {
  return (
    result.outcome === 'deferred' &&
    'code' in result &&
    result.forceable === true &&
    result.code === ORCAD_UPDATE_TERMINALS_RUNNING_CODE
  )
}

function outcomeMessage(result: Parameters<typeof managedServerOutcomeLabel>[0]): string | null {
  return result.outcome === 'deferred' ||
    result.outcome === 'refused' ||
    result.outcome === 'failed'
    ? managedServerOutcomeLabel(result)
    : null
}

export function useManagedServerLifecycle({
  api,
  environment,
  onChanged
}: {
  api: ManagedOrcadPreloadApi
  environment: Pick<PublicKnownRuntimeEnvironment, 'id'>
  onChanged: () => void
}): ManagedServerLifecycle {
  const mountedRef = useMountedRef()
  const [status, setStatus] = useState<OrcadManagedRuntimeStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [busy, setBusy] = useState<ManagedServerAction | 'status' | null>(null)
  const [confirmingStop, setStopConfirmation] = useState(false)
  const [confirmingForget, setForgetConfirmation] = useState(false)
  const [confirmingRestore, setRestoreConfirmation] = useState(false)
  const [forceUpdateRequest, setForceUpdateRequest] =
    useState<OrcadManagedPastLiveTerminals | null>(null)
  // Why one choke point: the row shows one confirmation, so opening any closes the rest.
  const openConfirmation = (
    open: 'stop' | 'forget' | 'restore' | 'forceUpdate' | null,
    forceUpdate: OrcadManagedPastLiveTerminals | null = null
  ): void => {
    setStopConfirmation(open === 'stop')
    setForgetConfirmation(open === 'forget')
    setRestoreConfirmation(open === 'restore')
    setForceUpdateRequest(open === 'forceUpdate' ? forceUpdate : null)
  }
  const setConfirmingStop = (value: boolean): void => openConfirmation(value ? 'stop' : null)
  const setConfirmingForget = (value: boolean): void => openConfirmation(value ? 'forget' : null)
  const setConfirmingRestore = (value: boolean): void => openConfirmation(value ? 'restore' : null)
  const setConfirmingForceUpdate = (value: OrcadManagedPastLiveTerminals | null): void =>
    openConfirmation(value ? 'forceUpdate' : null, value)
  // Why derived: another desktop's activation, a stop or a migration voids the confirmation.
  const confirmingForceUpdate =
    forceUpdateRequest &&
    status &&
    status.activeVersion === forceUpdateRequest.incumbentVersion &&
    !status.recovery &&
    !status.migration
      ? forceUpdateRequest
      : null

  const loadStatus = useCallback(async () => {
    setBusy('status')
    try {
      const next = await api.getStatus({ selector: environment.id })
      if (mountedRef.current) {
        setStatus(next)
        setStatusError(null)
      }
    } catch (error) {
      if (mountedRef.current) {
        setStatusError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (mountedRef.current) {
        setBusy(null)
      }
    }
  }, [api, environment.id, mountedRef])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const run = async (action: ManagedServerAction): Promise<void> => {
    const pastLiveTerminals = action === 'forceUpdate' ? confirmingForceUpdate : null
    if (action === 'forceUpdate' && !pastLiveTerminals) {
      return
    }
    // The build the operator saw running; Update anyway is refused if the host moved past it.
    const incumbentVersion = status?.activeVersion ?? null
    setBusy(action)
    try {
      const selector = { selector: environment.id }
      const result =
        action === 'update' || action === 'forceUpdate'
          ? await api.update(pastLiveTerminals ? { ...selector, pastLiveTerminals } : selector)
          : action === 'rollback'
            ? await api.rollback(selector)
            : action === 'recover' || action === 'restoreSnapshot'
              ? await api.recover({
                  ...selector,
                  acceptChangedState: action === 'restoreSnapshot'
                })
              : action === 'stop'
                ? await api.stop(selector)
                : action === 'forget'
                  ? await api.forget(selector)
                  : await api.cancelStop(selector)
      const forceable = action === 'update' && isLiveTerminalsDeferral(result)
      const message = forceable ? null : outcomeMessage(result)
      if (mountedRef.current) {
        if (forceable) {
          setConfirmingForceUpdate({ incumbentVersion })
        } else if (action === 'update' || action === 'forceUpdate') {
          setConfirmingForceUpdate(null)
        }
      }
      if (message) {
        toast.message(message)
      }
      if (
        mountedRef.current &&
        action === 'recover' &&
        result.outcome === 'refused' &&
        'code' in result &&
        result.code === ORCAD_RECOVERY_CHANGED_STATE_CODE
      ) {
        setConfirmingRestore(true)
      }
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      if (mountedRef.current) {
        setBusy(null)
      }
      void loadStatus()
    }
  }

  return {
    status,
    statusError,
    recovery: status?.recovery ?? null,
    busy,
    confirmingStop,
    confirmingForget,
    confirmingRestore,
    confirmingForceUpdate,
    setConfirmingForceUpdate,
    setConfirmingStop,
    setConfirmingForget,
    setConfirmingRestore,
    loadStatus,
    run
  }
}
