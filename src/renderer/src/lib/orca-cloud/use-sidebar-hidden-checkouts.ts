import { useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  readHiddenVmCheckouts,
  subscribeHiddenVmCheckouts,
  withOrcaCloudPrimaryHosts,
  type HiddenVmCheckouts
} from '@/lib/vm-create-hidden-checkouts'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { isOrcaCloudRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'

/** Orca Cloud sandbox hosts, newline-joined so the selector result compares by value. */
export function selectOrcaCloudHostIdsKey(state: Pick<AppState, 'runtimeEnvironments'>): string {
  return (state.runtimeEnvironments ?? [])
    .filter((environment) => isOrcaCloudRuntimeEnvironment(environment))
    .map((environment) => toRuntimeExecutionHostId(environment.id))
    .join('\n')
}

/** What sidebar lists hide: VM checkouts whose create is in progress, and every Orca Cloud clone. */
export function useSidebarHiddenCheckouts(): HiddenVmCheckouts {
  const pending = useSyncExternalStore(subscribeHiddenVmCheckouts, readHiddenVmCheckouts)
  const cloudHostIdsKey = useAppStore(selectOrcaCloudHostIdsKey)
  return useMemo(
    () =>
      withOrcaCloudPrimaryHosts(
        pending,
        new Set(cloudHostIdsKey ? cloudHostIdsKey.split('\n') : [])
      ),
    [pending, cloudHostIdsKey]
  )
}
