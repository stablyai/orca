import { useState } from 'react'
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
import { runWorktreeDeleteWithToast } from './delete-worktree-flow'
import type { SshWorkspaceForgetResolution } from './ssh-workspace-forget-resolution'

type ForgetSshWorkspaceModalData = {
  worktreeId: string
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
    // Prefer the live label, then the removed target's last known label (ghost
    // host), then the raw id as a last resort.
    return s.sshTargetLabels.get(targetId) ?? s.removedSshTargetLabels.get(targetId) ?? targetId
  })
  const [busy, setBusy] = useState<null | 'reconnect' | 'forget'>(null)
  const mountedRef = useMountedRef()

  if (!isForgetModalData(modalData)) {
    return null
  }
  const { worktreeId, displayName, resolution } = modalData
  const canReconnect = resolution.kind === 'disconnected'

  const done = (): void => {
    if (mountedRef.current) {
      setBusy(null)
      closeModal()
    }
  }

  // Reconnect the SSH target, then run the normal remote worktree removal.
  const handleReconnectAndDelete = async (): Promise<void> => {
    if (resolution.kind !== 'disconnected') {
      return
    }
    setBusy('reconnect')
    try {
      await window.api.ssh.connect({ targetId: resolution.targetId })
    } catch (err) {
      if (mountedRef.current) {
        setBusy(null)
      }
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.sidebar.ForgetSshWorkspaceDialog.reconnectFailed',
              'Reconnection failed'
            )
      )
      return
    }
    // Close before the delete toast fires so the two don't overlap.
    closeModal()
    void runWorktreeDeleteWithToast(worktreeId, displayName)
    if (mountedRef.current) {
      setBusy(null)
    }
  }

  // Remove Orca's records only — never touches remote files, worktrees, or branches.
  const handleForget = async (): Promise<void> => {
    setBusy('forget')
    try {
      const result = await useAppStore
        .getState()
        .removeWorktree(worktreeId, false, { mode: 'forget-local' })
      if (!result.ok) {
        toast.error(result.error)
        if (mountedRef.current) {
          setBusy(null)
        }
        return
      }
      done()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      if (mountedRef.current) {
        setBusy(null)
      }
    }
  }

  const forgetDescription = translate(
    'auto.components.sidebar.ForgetSshWorkspaceDialog.forgetBody',
    'Removes this workspace from Orca only. Files, the Git worktree, and branches on {{host}} are left untouched.',
    { host: hostLabel }
  )

  return (
    <Dialog open onOpenChange={(open) => (!open ? closeModal() : undefined)}>
      <DialogContent className="sm:max-w-md gap-3 p-5" showCloseButton={false}>
        <DialogHeader className="gap-1">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <ServerOff className="size-4 text-muted-foreground" />
            {translate(
              'auto.components.sidebar.ForgetSshWorkspaceDialog.title',
              'Delete “{{name}}”?',
              {
                name: displayName
              }
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {canReconnect
              ? translate(
                  'auto.components.sidebar.ForgetSshWorkspaceDialog.disconnectedBody',
                  'The SSH host for this workspace is not connected. Reconnect to delete it on the remote too, or remove it from Orca only.'
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

        {/* Why: the ghost-host description already states files are untouched, so
            only repeat the reassurance on the reconnect (disconnected) path. */}
        {canReconnect ? (
          <p className="text-[11px] leading-snug text-muted-foreground">{forgetDescription}</p>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" size="sm" onClick={() => closeModal()} disabled={busy != null}>
            {translate('auto.components.sidebar.ForgetSshWorkspaceDialog.cancel', 'Cancel')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleForget()}
            disabled={busy != null}
          >
            {busy === 'forget' ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {translate(
              'auto.components.sidebar.ForgetSshWorkspaceDialog.forget',
              'Remove from Orca'
            )}
          </Button>
          {canReconnect ? (
            <Button
              size="sm"
              onClick={() => void handleReconnectAndDelete()}
              disabled={busy != null}
            >
              {busy === 'reconnect' ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {translate(
                'auto.components.sidebar.ForgetSshWorkspaceDialog.reconnectAndDelete',
                'Reconnect & Delete'
              )}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ForgetSshWorkspaceDialog
