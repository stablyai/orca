import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  isOrcadUncountedTerminalsDeferral,
  ORCAD_RECOVERY_CHANGED_STATE_CODE,
  ORCAD_UPDATE_TERMINALS_RUNNING_CODE,
  type OrcadManagedDeferral,
  type OrcadManagedPastLiveTerminals,
  type OrcadManagedRuntimeStatus
} from '../../../../../../shared/remote-runtime/orcad-lifecycle/orcad-managed-runtime'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { ManagedOrcadPreloadApi } from '../../../../../../preload/api/runtime/managed-orcad-api'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useRuntimeHostStatusSelector } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import {
  lastVerifiedRuntimeStatus,
  type RuntimeEnvironmentStatus
} from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
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
  /** An Update deferred only by running or uncounted terminals, which Update anyway restarts past. */
  confirmingForceUpdate: OrcadManagedPastLiveTerminals | null
  setConfirmingForceUpdate: (value: OrcadManagedPastLiveTerminals | null) => void
  setConfirmingStop: (value: boolean) => void
  setConfirmingForget: (value: boolean) => void
  setConfirmingRestore: (value: boolean) => void
  loadStatus: () => Promise<void>
  run: (action: ManagedServerAction) => Promise<void>
}

/** The confirmation an Update anyway needs, or null when force cannot pass this result. */
function forceableTerminalsDeferral(
  result: { outcome: string } | OrcadManagedDeferral
): 'counted' | 'uncounted' | null {
  if (result.outcome !== 'deferred' || !('code' in result) || result.forceable !== true) {
    return null
  }
  if (result.code === ORCAD_UPDATE_TERMINALS_RUNNING_CODE) {
    return 'counted'
  }
  return isOrcadUncountedTerminalsDeferral(result.code) ? 'uncounted' : null
}

function outcomeMessage(result: Parameters<typeof managedServerOutcomeLabel>[0]): string | null {
  return result.outcome === 'deferred' ||
    result.outcome === 'refused' ||
    result.outcome === 'failed'
    ? managedServerOutcomeLabel(result)
    : null
}

// Kept across lost probes, so only a server that comes back as a new process changes it.
const selectVerifiedRuntimeId = (entry: RuntimeEnvironmentStatus | undefined): string | null =>
  lastVerifiedRuntimeStatus(entry)?.runtimeId ?? null

type StatusRead = { environmentId: string; runtimeId: string | null }

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
  // Why separate: a status read settling mid-action must not end the action's busy state.
  const [actionBusy, setActionBusy] = useState<ManagedServerAction | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
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

  // Why: an update can land outside this row (a deferred one retried on reconnect), and its
  // restarted server must not keep showing the deferral or the old version.
  const runtimeId = useRuntimeHostStatusSelector(environment.id, selectVerifiedRuntimeId)
  const runtimeIdRef = useRef(runtimeId)
  useEffect(() => {
    runtimeIdRef.current = runtimeId
  }, [runtimeId])
  // The newest read: only it may publish, and it records the verified runtime it started under.
  const latestReadRef = useRef<StatusRead | null>(null)
  const actionRef = useRef<object | null>(null)

  const loadStatus = useCallback(async () => {
    const read: StatusRead = { environmentId: environment.id, runtimeId: runtimeIdRef.current }
    latestReadRef.current = read
    const current = (): boolean => mountedRef.current && latestReadRef.current === read
    setStatusLoading(true)
    try {
      const next = await api.getStatus({ selector: read.environmentId })
      if (current()) {
        setStatus(next)
        setStatusError(null)
      }
    } catch (error) {
      if (current()) {
        setStatusError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (current()) {
        setStatusLoading(false)
      }
    }
  }, [api, environment.id, mountedRef])

  useEffect(() => {
    const latest = latestReadRef.current
    // A read that started under this runtime already covers it; an unknown runtime proves nothing new.
    const covered =
      latest !== null &&
      latest.environmentId === environment.id &&
      (runtimeId === null || latest.runtimeId === runtimeId)
    // A running action reads once it ends, under the runtime current then.
    if (!covered && actionRef.current === null) {
      void loadStatus()
    }
  }, [environment.id, runtimeId, loadStatus])

  const run = async (action: ManagedServerAction): Promise<void> => {
    const pastLiveTerminals = action === 'forceUpdate' ? confirmingForceUpdate : null
    if (action === 'forceUpdate' && !pastLiveTerminals) {
      return
    }
    const owner = {}
    actionRef.current = owner
    // The build the operator saw running; Update anyway is refused if the host moved past it.
    const incumbentVersion = status?.activeVersion ?? null
    setActionBusy(action)
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
      const forceable = action === 'update' ? forceableTerminalsDeferral(result) : null
      const message = forceable ? null : outcomeMessage(result)
      if (mountedRef.current) {
        if (forceable) {
          setConfirmingForceUpdate({
            incumbentVersion,
            ...(forceable === 'uncounted' ? { uncounted: true as const } : {})
          })
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
      if (actionRef.current === owner) {
        actionRef.current = null
        if (mountedRef.current) {
          setActionBusy(null)
        }
      }
      void loadStatus()
    }
  }

  return {
    status,
    statusError,
    recovery: status?.recovery ?? null,
    busy: actionBusy ?? (statusLoading ? 'status' : null),
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
