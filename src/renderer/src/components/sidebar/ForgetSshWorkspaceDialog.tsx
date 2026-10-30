import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Server, ServerOff } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import type { WorktreeRemovalTarget } from '../../../../shared/worktree/removal'
import type { SshWorkspaceForgetResolution } from './ssh-workspace-forget-resolution'
import { RemovalUnsavedFilesNotice } from './RemovalUnsavedFilesNotice'
import { confirmUnsavedDiscard } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'
import { getWorktreeOnHostFromState } from '@/store/selectors'
import {
  readWorktreeDeleteIdentities,
  resolveWorktreeBatchDeleteTargets
} from './worktree-delete-request'
import { showWorkspaceListChangedToast } from './stale-workspace-list-toast'

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
      <DialogContent surface="security" className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader className="gap-1">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <ServerOff className="size-4 text-muted-foreground" />
            {translate(
              'auto.components.sidebar.ForgetSshWorkspaceDialog.removeTitle',
              'Remove “{{name}}” from Orca?',
              { name: displayName }
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {resolution.kind === 'saved'
              ? translate(
                  'auto.components.sidebar.ForgetSshWorkspaceDialog.savedHostBody',
                  'This workspace’s project isn’t served by Orca’s server on {{host}}, so Orca can’t delete it there. You can remove it from Orca; files, the Git worktree, and branches on {{host}} are left untouched.',
                  { host: hostLabel }
                )
              : translate(
                  'auto.components.sidebar.ForgetSshWorkspaceDialog.ghostBody',
                  '{{host}} is no longer a saved SSH host, so this workspace is no longer connected to a live host. It can only be removed from Orca — files and branches on the remote are left untouched.',
                  { host: hostLabel }
                )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2.5 rounded-md border border-border/50 bg-card/40 px-3 py-2">
          <Server className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{hostLabel}</span>
        </div>

        <RemovalUnsavedFilesNotice targets={unsavedTargets} enabled />

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" size="sm" onClick={() => closeModal()} disabled={busy}>
            {translate('auto.components.sidebar.ForgetSshWorkspaceDialog.cancel', 'Cancel')}
          </Button>
          <Button size="sm" onClick={() => void handleForget()} disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {translate(
              'auto.components.sidebar.ForgetSshWorkspaceDialog.forget',
              'Remove from Orca'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ForgetSshWorkspaceDialog
