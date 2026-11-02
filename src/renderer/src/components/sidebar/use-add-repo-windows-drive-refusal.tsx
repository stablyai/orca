import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { WslHostWindowsDriveRefusal } from '../../../../shared/wsl-host-windows-drive-refusal'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import { isWindowsDesktopClient } from '@/lib/windows-path-access'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import { AddRepoWindowsDriveNotice } from './AddRepoWindowsDriveNotice'

type RefusedAction = 'add' | 'create'

/**
 * Holds a WSL host's Windows drive refusal and switches the open dialog to this computer to add
 * the folder there. Call after the dialog's host-change reset: its effect must run first, or it
 * cancels the add this hook starts in the same commit.
 */
export function useAddRepoWindowsDriveRefusal({
  isOpen,
  selectedHostId,
  selectHost,
  addLocalPath,
  createStep
}: {
  isOpen: boolean
  selectedHostId: ExecutionHostId | null
  selectHost: (hostId: ExecutionHostId) => Promise<boolean>
  addLocalPath: (path: string, source: AddRepoExistingWorkspaceSource) => Promise<unknown>
  /** A refused create reopens the create step on this computer with the parent folder filled in. */
  createStep: {
    setStep: (step: AddRepoDialogStep) => void
    setCreateParent: (path: string) => void
  }
}): {
  notice: ReactNode
  showRefusal: (refusal: WslHostWindowsDriveRefusal, action?: RefusedAction) => void
} {
  const [shown, setShown] = useState<{
    refusal: WslHostWindowsDriveRefusal
    action: RefusedAction
    hostId: ExecutionHostId | null
  } | null>(null)
  const [wasOpen, setWasOpen] = useState(isOpen)
  // Closing the dialog drops its refusal (adjusted during render, not in an effect).
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen)
    if (!isOpen) {
      setShown(null)
    }
  }
  const pendingRef = useRef<{ path: string; action: RefusedAction } | null>(null)

  useEffect(() => {
    const pending = pendingRef.current
    if (!isOpen) {
      pendingRef.current = null
      return
    }
    if (!pending || selectedHostId !== LOCAL_EXECUTION_HOST_ID) {
      return
    }
    pendingRef.current = null
    if (pending.action === 'create') {
      createStep.setStep('create')
      createStep.setCreateParent(pending.path)
      return
    }
    void addLocalPath(pending.path, 'local_folder_picker')
  }, [addLocalPath, createStep, isOpen, selectedHostId])

  const action = shown?.action ?? 'add'
  const addOnThisComputer = useCallback(
    (windowsPath: string) => {
      const pending = { path: windowsPath, action }
      pendingRef.current = pending
      void selectHost(LOCAL_EXECUTION_HOST_ID).then((selected) => {
        // Not switched: a later manual switch to this computer must not fire this add.
        if (!selected && pendingRef.current === pending) {
          pendingRef.current = null
        }
      })
    },
    [action, selectHost]
  )
  const showRefusal = useCallback(
    (refusal: WslHostWindowsDriveRefusal, refusedAction: RefusedAction = 'add') =>
      setShown({ refusal, action: refusedAction, hostId: selectedHostId }),
    [selectedHostId]
  )

  return {
    // A refusal belongs to the host that produced it.
    notice:
      shown && shown.hostId === selectedHostId ? (
        <AddRepoWindowsDriveNotice
          refusal={shown.refusal}
          // Only a Windows desktop can add a Windows drive folder on this computer.
          onAddOnThisComputer={isWindowsDesktopClient() ? addOnThisComputer : null}
        />
      ) : null,
    showRefusal
  }
}
