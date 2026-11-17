import React from 'react'
import { useAppStore } from '@/store'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { useWorktreeCreationClock } from './worktree-creation-clock'
import { buildClockElapsedMs } from './worktree-creation-clock-cloud'
import { VmDeleteConfirmDialog } from './VmDeleteConfirmDialog'
import { preloadCloudOpenCover } from './CloudOpenCoverLayer'
import { composerDataFromRefusedCreate } from './vm-build-composer-return'

type VmBuildPanel = {
  now: number
  /** The build's own elapsed time (pauses and waits left out). */
  elapsedMs: number
  /** A VM build keeps its sheet through fetch and checkout, so it never drops to the one-line status. */
  isVmBuild: boolean
  /** Leaves the build; confirms first when a VM is still up, since dismissing deletes it. */
  leave: () => void
  /** The delete-VM confirmation, rendered by the panel. */
  deleteConfirm: React.ReactNode
  /** Leaves a refused build for the composer with its prompt; `local` runs it on this computer. */
  returnToComposer: (options: { local: boolean; pickRepo?: boolean }) => void
}

/** The creation panel's VM build behaviour: paused clock, delete confirm, and return to composer. */
export function useVmBuildPanelCloud(
  creationId: string,
  entry: PendingWorktreeCreation | undefined
): VmBuildPanel {
  const [confirmingDelete, setConfirmingDelete] = React.useState(false)
  // Depend on primitives so stderr’s fresh entry objects cannot continuously reset the interval;
  // a build paused on failed checks waits on the user, so its clock stops.
  const now = useWorktreeCreationClock(
    entry?.status === 'creating' && entry.waitingSince === undefined
  )
  const cloudCreate = entry?.request.ephemeralVmRecipe?.provider === 'orca-cloud'
  React.useEffect(() => {
    // The open cover takes over from this panel when the create finishes.
    if (cloudCreate) {
      void preloadCloudOpenCover()
    }
  }, [cloudCreate])

  const dismiss = (): void => useAppStore.getState().removePendingWorktreeCreation(creationId)
  // A failed or paused VM build still holds a VM that dismissing deletes, so confirm first.
  const holdsVm = entry
    ? (entry.environmentCheck?.status === 'failed' &&
        entry.environmentCheck.sandbox !== 'deleted') ||
      (entry.status === 'error' && Boolean(entry.request.ephemeralVmRuntimeId))
    : false
  return {
    now,
    elapsedMs: entry ? buildClockElapsedMs(entry, now) : 0,
    isVmBuild: Boolean(entry?.request.ephemeralVmRecipe) || entry?.phase === 'provisioning-vm',
    leave: holdsVm ? () => setConfirmingDelete(true) : dismiss,
    deleteConfirm: holdsVm ? (
      <VmDeleteConfirmDialog
        open={confirmingDelete}
        cloud={cloudCreate}
        onOpenChange={setConfirmingDelete}
        onConfirm={() => {
          setConfirmingDelete(false)
          dismiss()
        }}
      />
    ) : null,
    returnToComposer: ({ local, pickRepo }) => {
      if (!entry) {
        return
      }
      const data = composerDataFromRefusedCreate(entry, { local, pickRepo })
      dismiss()
      const store = useAppStore.getState()
      // Never replace a dialog the user opened meanwhile.
      if (store.activeModal === 'none') {
        store.openModal('new-workspace-composer', data)
      }
    }
  }
}
