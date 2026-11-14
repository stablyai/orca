import { useMemo } from 'react'
import { useAppStore } from '@/store/index'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { readWslHostWindowsDriveRefusal } from '../../../../../../shared/wsl-host-windows-drive-refusal'
import {
  readDroppedHostPath,
  type DroppedHostPath
} from '../host-selection/add-repo-wsl-host-folder-picker'
import type { AddRepoDialogEntryRequest } from './add-repo-dialog-types'

function isExecutionHostId(value: unknown): value is ExecutionHostId {
  return typeof value === 'string' && parseExecutionHostId(value) !== null
}

function readModalEntryRequest(value: unknown): AddRepoDialogEntryRequest | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record: Record<string, unknown> = { ...value }
  if (typeof record.id !== 'number') {
    return null
  }
  if (
    (record.kind === 'clone' || record.kind === 'create' || record.kind === 'browse-runtime') &&
    (record.hostId === null || isExecutionHostId(record.hostId))
  ) {
    return { id: record.id, kind: record.kind, hostId: record.hostId }
  }
  if (!isExecutionHostId(record.hostId)) {
    return null
  }
  if (
    record.kind === 'picked-local-paths' &&
    Array.isArray(record.paths) &&
    record.paths.every((entry): entry is string => typeof entry === 'string')
  ) {
    return { id: record.id, kind: 'picked-local-paths', hostId: record.hostId, paths: record.paths }
  }
  if (record.kind === 'picked-wsl-host-path' && typeof record.path === 'string') {
    return { id: record.id, kind: 'picked-wsl-host-path', hostId: record.hostId, path: record.path }
  }
  if (record.kind === 'wsl-windows-drive-refusal') {
    const refusal = readWslHostWindowsDriveRefusal(record.refusal)
    if (refusal) {
      return {
        id: record.id,
        kind: 'wsl-windows-drive-refusal',
        hostId: record.hostId,
        refusal
      }
    }
  }
  return null
}

/** Paths and direct-entry requests the dialog was opened with. */
export function useAddRepoDialogModalPaths(
  hosted: boolean,
  hostedEntryRequest?: AddRepoDialogEntryRequest | null
): {
  droppedLocalPath: string
  pickedLocalPaths: readonly string[] | null
  droppedHostPath: DroppedHostPath | null
  preferredHostId: ExecutionHostId | null
  entryRequest: AddRepoDialogEntryRequest | null
} {
  const droppedLocalPath = useAppStore((s) =>
    !hosted && typeof s.modalData.droppedLocalPath === 'string' ? s.modalData.droppedLocalPath : ''
  )
  // A Windows drive folder refused by a WSL host, reopened here for this computer.
  const addOnThisComputerPath = useAppStore((s) =>
    !hosted && typeof s.modalData.addOnThisComputerPath === 'string'
      ? s.modalData.addOnThisComputerPath
      : ''
  )
  const droppedHostPathData = useAppStore((s) => (hosted ? undefined : s.modalData.droppedHostPath))
  const storeEntryRequestData = useAppStore((s) => (hosted ? undefined : s.modalData.entryRequest))
  const entryRequest = useMemo(
    () => (hosted ? (hostedEntryRequest ?? null) : readModalEntryRequest(storeEntryRequestData)),
    [hosted, hostedEntryRequest, storeEntryRequestData]
  )
  const droppedHostPath = useMemo(() => {
    if (entryRequest?.kind === 'picked-wsl-host-path') {
      return { hostId: entryRequest.hostId, path: entryRequest.path }
    }
    return readDroppedHostPath({ droppedHostPath: droppedHostPathData })
  }, [droppedHostPathData, entryRequest])
  const pickedLocalPaths = entryRequest?.kind === 'picked-local-paths' ? entryRequest.paths : null
  return {
    droppedLocalPath: droppedLocalPath || addOnThisComputerPath,
    pickedLocalPaths,
    droppedHostPath,
    preferredHostId:
      entryRequest?.hostId ??
      droppedHostPath?.hostId ??
      (addOnThisComputerPath ? LOCAL_EXECUTION_HOST_ID : null),
    entryRequest
  }
}
