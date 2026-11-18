import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store/index'
import {
  readLocalRuntimeCapabilityObservation,
  refreshLocalRuntimeCapabilities,
  subscribeLocalRuntimeCapabilityObservation
} from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus
} from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { GIT_SUBMODULE_WORKING_STATUS_RUNTIME_CAPABILITY } from '../../../../../../shared/source-control/runtime/source-control-runtime-capabilities'

export type SubmoduleWorkingStatusSupport = 'pending' | 'supported' | 'unsupported'

/** Older hosts strip `workingTreeOnly` and return committed ranges; gate moved submodules on the capability. */
export function useSubmoduleWorkingStatusSupport(
  target: RuntimeClientTarget | null
): SubmoduleWorkingStatusSupport {
  const localObservation = useSyncExternalStore(
    subscribeLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation
  )
  const remoteStoreSupport = useAppStore((s): SubmoduleWorkingStatusSupport => {
    if (target?.kind !== 'environment') {
      return 'pending'
    }
    const entry = s.runtimeStatusByEnvironmentId.get(target.environmentId)
    if (!entry || isRuntimeHostContactRevoked(entry)) {
      return 'pending'
    }
    const verified = lastVerifiedRuntimeStatus(entry)
    if (!verified) {
      return 'pending'
    }
    return verified.capabilities?.includes(GIT_SUBMODULE_WORKING_STATUS_RUNTIME_CAPABILITY)
      ? 'supported'
      : 'unsupported'
  })
  const [probedRemote, setProbedRemote] = useState<{
    environmentId: string
    support: 'supported' | 'unsupported'
  } | null>(null)

  const support: SubmoduleWorkingStatusSupport = useMemo(() => {
    if (!target) {
      return 'pending'
    }
    if (target.kind === 'local') {
      if (localObservation.state === 'known') {
        return localObservation.capabilities.includes(
          GIT_SUBMODULE_WORKING_STATUS_RUNTIME_CAPABILITY
        )
          ? 'supported'
          : 'unsupported'
      }
      return localObservation.state === 'unavailable' ? 'unsupported' : 'pending'
    }
    if (remoteStoreSupport !== 'pending') {
      return remoteStoreSupport
    }
    return probedRemote?.environmentId === target.environmentId ? probedRemote.support : 'pending'
  }, [localObservation, probedRemote, remoteStoreSupport, target])

  useEffect(() => {
    if (!target || support !== 'pending') {
      return
    }
    if (target.kind === 'local') {
      void refreshLocalRuntimeCapabilities()
      return
    }
    let canceled = false
    const environmentId = target.environmentId
    void runtimeEnvironmentSupportsCapability(
      environmentId,
      GIT_SUBMODULE_WORKING_STATUS_RUNTIME_CAPABILITY
    )
      .then((supported) => {
        if (!canceled) {
          setProbedRemote({ environmentId, support: supported ? 'supported' : 'unsupported' })
        }
      })
      .catch(() => {
        if (!canceled) {
          setProbedRemote({ environmentId, support: 'unsupported' })
        }
      })
    return () => {
      canceled = true
    }
  }, [support, target])

  return support
}
