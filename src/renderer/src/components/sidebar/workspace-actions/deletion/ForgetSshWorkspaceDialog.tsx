import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DialogCancel, DialogWarning } from '@/components/ui/dialog-parts'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { toSshExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { WorktreeRemovalTarget } from '../../../../../../shared/worktree/removal/removal'
import type { SshWorkspaceForgetResolution } from './ssh-workspace-forget-resolution'
import { useRemovalUnsavedFiles } from './use-removal-unsaved-files'
import { unsavedFilesLine } from './removal-unsaved-files'
import type { SshConnectionStatus } from '../../../../../../shared/remote-runtime/ssh/ssh-types'
import { confirmUnsavedDiscard } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'
import { getWorktreeOnHostFromState } from '@/store/workspaces/selection/worktree-on-host-selector'
import {
  readWorktreeDeleteIdentities,
  resolveWorktreeBatchDeleteTargets
} from './worktree-delete-request'
import { showWorkspaceListChangedToast } from '../../worktree-list/listing/stale-workspace-list-toast'

type ForgetSshWorkspaceModalData = {
  worktreeId: string
  worktreeDeleteIdentities?: unknown
  displayName: string
  resolution: SshWorkspaceForgetResolution
}

function isForgetModalData(data: unknown): data is ForgetSshWorkspaceModalData {
  if (!data || typeof data !== 'object') {
    return false
  }
  const candidate = data as Partial<ForgetSshWorkspaceModalData>
  return typeof candidate.worktreeId === 'string' && candidate.resolution != null
}

export function ForgetSshWorkspaceDialog(): React.JSX.Element | null {
  const t = useTranslate()
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const hostLabel = useAppStore((s) => {
    const resolution = isForgetModalData(s.modalData) ? s.modalData.resolution : null
    const targetId = resolution && resolution.kind !== 'not-ssh' ? resolution.targetId : undefined
    if (!targetId) {
      return ''
    }
    // Retain removed-host labels for ghost workspaces before falling back to raw IDs.
    return s.sshTargetLabels.get(targetId) ?? s.removedSshTargetLabels.get(targetId) ?? targetId
  })
  const connectionStatus = useAppStore((s): SshConnectionStatus | undefined => {
    const resolution = isForgetModalData(s.modalData) ? s.modalData.resolution : null
    return resolution?.kind === 'saved'
      ? s.sshConnectionStates.get(resolution.targetId)?.status
      : undefined
  })
  const [busy, setBusy] = useState(false)
  const mountedRef = useMountedRef()
  const unsavedTargets = useMemo(
    () =>
      isForgetModalData(modalData) && modalData.resolution.kind !== 'not-ssh'
        ? [
            {
              id: modalData.worktreeId,
              hostId: toSshExecutionHostId(modalData.resolution.targetId)
            }
          ]
        : [],
    [modalData]
  )
  const unsavedFiles = useRemovalUnsavedFiles(unsavedTargets, unsavedTargets.length > 0)

  if (!isForgetModalData(modalData)) {
    return null
  }
  const { worktreeId, displayName, resolution } = modalData
  // This workspace’s named SSH target is the host confirmed for removal.
  const removalTarget: WorktreeRemovalTarget = {
    id: worktreeId,
    executionHostId:
      resolution.kind === 'not-ssh' ? null : toSshExecutionHostId(resolution.targetId)
  }

  // Why (STA-11912): a replacement at the same host and id must not inherit this confirmation.
  const selectedIdentities = readWorktreeDeleteIdentities(modalData.worktreeDeleteIdentities)
  const isSelectedWorkspaceCurrent = (): boolean => {
    if (selectedIdentities.length !== 1) {
      return false
    }
    const state = useAppStore.getState()
    const targets = resolveWorktreeBatchDeleteTargets(selectedIdentities, (id, hostId) =>
      getWorktreeOnHostFromState(state, id, hostId)
    )
    return targets?.length === 1
  }
  const refuseReplacedSelection = (): void => {
    showWorkspaceListChangedToast()
    if (mountedRef.current) {
      setBusy(false)
    }
    closeModal()
  }

  const done = (): void => {
    if (mountedRef.current) {
      setBusy(false)
      closeModal()
    }
  }

  // Forget only Orca’s records; remote files, worktrees and branches survive.
  const handleForget = async (): Promise<void> => {
    if (!isSelectedWorkspaceCurrent()) {
      refuseReplacedSelection()
      return
    }
    const confirmedDiscards = confirmUnsavedDiscard(useAppStore.getState, unsavedTargets)
    setBusy(true)
    try {
      const result = await useAppStore
        .getState()
        .removeWorktree(removalTarget, false, { mode: 'forget-local', confirmedDiscards })
      if (!result.ok) {
        toast.error(result.error)
        if (mountedRef.current) {
          setBusy(false)
        }
        return
      }
      done()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? closeModal() : undefined)}>
      <DialogContent size="confirm" surface="security" busy={busy} initialFocus="cancel">
        <DialogHeader>
          <DialogTitle>
            {t(
              'components.sidebar.ForgetSshWorkspaceDialog.removeFromOrcaTitle',
              'Remove {{name}} from Orca?',
              { name: displayName }
            )}
          </DialogTitle>
          <DialogDescription>
            {resolution.kind !== 'saved'
              ? t(
                  'components.sidebar.ForgetSshWorkspaceDialog.ghostHostLine',
                  '{{host}} is no longer a saved host. Its files stay on it.',
                  { host: hostLabel }
                )
              : // Why only disconnected: other states may still recover, so the copy stays neutral.
                connectionStatus === 'disconnected'
                ? t(
                    'components.sidebar.ForgetSshWorkspaceDialog.disconnectedHostLine',
                    '{{host}} isn’t connected. Its files stay on the host.',
                    { host: hostLabel }
                  )
                : t(
                    'components.sidebar.ForgetSshWorkspaceDialog.filesStayLine',
                    'Its files stay on {{host}}.',
                    { host: hostLabel }
                  )}
          </DialogDescription>
        </DialogHeader>

        {unsavedFiles.length > 0 ? (
          <DialogWarning>{unsavedFilesLine(unsavedFiles, t)}</DialogWarning>
        ) : null}

        <DialogFooter>
          <DialogCancel>
            {t('auto.components.sidebar.ForgetSshWorkspaceDialog.cancel', 'Cancel')}
          </DialogCancel>
          <Button size="sm" onClick={() => void handleForget()} disabled={busy}>
            {busy
              ? t('components.sidebar.ForgetSshWorkspaceDialog.removing', 'Removing…')
              : t('auto.components.sidebar.ForgetSshWorkspaceDialog.forget', 'Remove from Orca')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ForgetSshWorkspaceDialog
