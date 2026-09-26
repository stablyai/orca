import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '../../store'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import {
  isRemoteResourceManagerHost,
  listResourceManagerHosts,
  resolveDefaultResourceManagerHostIdFromState,
  resolveSelectedResourceManagerHostId
} from './resource-manager-hosts'

/** Which machine the Resource Manager popover reports on, and that host's snapshot. */
export function useResourceManagerHostSelection() {
  const snapshotByHostId = useAppStore((s) => s.memorySnapshotByHostId)
  const snapshotErrorByHostId = useAppStore((s) => s.memorySnapshotErrorByHostId)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const settings = useAppStore((s) => s.settings)
  const [selectedHostId, setSelectedHostId] = useState<string>(LOCAL_EXECUTION_HOST_ID)

  const hostLabelOverrides = useMemo(() => getHostDisplayLabelOverrides(settings), [settings])
  const resourceHosts = useMemo(
    () =>
      listResourceManagerHosts({
        runtimeEnvironments,
        runtimeStatusByEnvironmentId,
        hostLabelOverrides,
        selectedHostId,
        isPairedWebClient: isPairedWebClientWindow()
      }),
    [runtimeEnvironments, runtimeStatusByEnvironmentId, hostLabelOverrides, selectedHostId]
  )
  // Why: a host can disconnect while the popover is open; fall back rather than
  // polling an id that no longer resolves.
  const activeHostId = resolveSelectedResourceManagerHostId(resourceHosts, selectedHostId)
  const viewingRemoteHost = isRemoteResourceManagerHost(activeHostId)
  const resourceSnapshotError = snapshotErrorByHostId[activeHostId] ?? null
  // Why: an unreachable remote host is unverifiable, never idle — and a stale
  // reading left on screen under that banner would contradict it.
  const remoteHostUnreachable = viewingRemoteHost && resourceSnapshotError !== null
  const resourceSnapshot = remoteHostUnreachable ? null : (snapshotByHostId[activeHostId] ?? null)
  // Why: the closed status-bar badge reports this machine's own footprint; it must
  // not start describing a remote box because the popover was left on one.
  const localSnapshot = snapshotByHostId[LOCAL_EXECUTION_HOST_ID] ?? null
  const localSnapshotError = snapshotErrorByHostId[LOCAL_EXECUTION_HOST_ID] ?? null

  // Why: resolved on the open edge only, and from canonical state — the panel's own
  // slices are gated on `open`, which is still false here, so reading them would
  // resolve every workspace to the local host.
  const selectDefaultHost = useCallback((): void => {
    setSelectedHostId(
      resolveDefaultResourceManagerHostIdFromState(useAppStore.getState(), resourceHosts)
    )
  }, [resourceHosts])

  return {
    resourceHosts,
    activeHostId,
    setSelectedHostId,
    selectDefaultHost,
    viewingRemoteHost,
    remoteHostUnreachable,
    resourceSnapshot,
    localSnapshot,
    localSnapshotError
  }
}
