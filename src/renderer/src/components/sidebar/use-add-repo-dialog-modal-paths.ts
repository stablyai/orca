import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { readDroppedHostPath, type DroppedHostPath } from './add-repo-wsl-host-folder-picker'

/** Paths the store modal was opened with; hosted mode never carries them. */
export function useAddRepoDialogModalPaths(hosted: boolean): {
  droppedLocalPath: string
  droppedHostPath: DroppedHostPath | null
  preferredHostId: ExecutionHostId | null
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
  const droppedHostPath = useMemo(
    () => readDroppedHostPath({ droppedHostPath: droppedHostPathData }),
    [droppedHostPathData]
  )
  return {
    droppedLocalPath: droppedLocalPath || addOnThisComputerPath,
    droppedHostPath,
    preferredHostId:
      droppedHostPath?.hostId ?? (addOnThisComputerPath ? LOCAL_EXECUTION_HOST_ID : null)
  }
}
