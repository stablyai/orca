// Confirmation for row actions that take something away from people: handing ownership to someone
// else, archiving a teammate's running workspace (their agents stop) and deleting one.
import { archiveDialogKeptLine } from '@/components/orca-cloud/archive-snapshot-copy'
import { useArchiveTtlDays } from '@/lib/orca-cloud/archive-ttl'
import type React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DialogCancel, DialogError } from '@/components/ui/dialog-parts'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { memberName, type MemberDirectory } from './cloud-workspace-format'
import { cloudWorkspaceTitle } from './open-cloud-workspace'
import { ownerChangeConsequences } from './owner-change-copy'

export type PendingConfirm =
  | { kind: 'owner'; workspace: CloudWorkspace; ownerUserId: string }
  /** Archiving a teammate's running workspace stops their agents. */
  | { kind: 'archive'; workspace: CloudWorkspace }
  /** Deleting from the team list: the sandbox and its disk go. */
  | { kind: 'delete'; workspace: CloudWorkspace }

export function CloudWorkspaceConfirmDialog({
  pending,
  directory,
  selfId,
  canAdmin,
  busy = false,
  error = null,
  onCancel,
  onConfirm
}: {
  pending: PendingConfirm
  directory: MemberDirectory
  selfId: string | null
  /** Team owner or admin: still manages every workspace after giving one away. */
  canAdmin: boolean
  /** The change is being made (the workspace goes to sleep first, so it takes a while). */
  busy?: boolean
  /** Why the last try changed nothing, shown in place so the person can try again. */
  error?: string | null
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const w = pending.workspace
  const title =
    pending.kind === 'archive'
      ? t('auto.components.cloudWorkspaces.archiveConfirmTitle', 'Archive {{name}}?', {
          name: cloudWorkspaceTitle(w, t)
        })
      : pending.kind === 'delete'
        ? t('auto.components.cloudWorkspaces.deleteConfirmTitle', 'Delete {{name}}?', {
            name: cloudWorkspaceTitle(w, t)
          })
        : t('auto.components.cloudWorkspaces.reassignTitle', 'Make {{name}} the owner?', {
            name: memberName(directory, pending.ownerUserId, selfId, t)
          })
  // How long archive keeps it, in the same relative words as the Archive tooltip.
  const archiveKept = archiveDialogKeptLine(t, useArchiveTtlDays())
  const losesManagement = pending.kind === 'owner' && w.ownerUserId === selfId && !canAdmin
  // Destructive for someone else (their agents stop, or you lose access): focus starts on Cancel,
  // as upstream's destructive confirms do; otherwise on the action.
  const focusCancel = losesManagement || pending.kind === 'archive' || pending.kind === 'delete'
  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent
        size="confirm"
        surface={pending.kind === 'delete' ? 'security' : undefined}
        busy={busy}
        initialFocus={focusCancel ? 'cancel' : undefined}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {pending.kind === 'delete' ? (
            <DialogDescription>
              {t(
                'auto.components.sidebar.DeleteCloudWorkspace.bodyNoSnapshot',
                'Deletes the workspace and all its files, chats and uncommitted changes. This can’t be undone.'
              )}
            </DialogDescription>
          ) : pending.kind === 'archive' ? (
            <DialogDescription>
              {t(
                'auto.components.cloudWorkspaces.archiveConfirmStops',
                "{{owner}}'s agents in this workspace will stop.",
                { owner: memberName(directory, w.ownerUserId, selfId, t) }
              )}{' '}
              {archiveKept}
            </DialogDescription>
          ) : (
            <>
              {/* What the change does, before who manages it afterwards. */}
              <ul className="list-disc space-y-1 pl-5 text-left text-[13px] text-muted-foreground">
                {ownerChangeConsequences(
                  w.ownerUserId === selfId ? null : memberName(directory, w.ownerUserId, selfId, t),
                  t
                ).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <DialogDescription>
                {losesManagement
                  ? t(
                      'auto.components.cloudWorkspaces.reassignLosesManagement',
                      "You won't be able to manage this workspace after this."
                    )
                  : t(
                      'auto.components.cloudWorkspaces.reassignBody',
                      'They can then archive it, delete it or make someone else the owner.'
                    )}
              </DialogDescription>
            </>
          )}
        </DialogHeader>
        {error ? <DialogError>{error}</DialogError> : null}
        <DialogFooter>
          <DialogCancel>{t('auto.components.cloudWorkspaces.cancel', 'Cancel')}</DialogCancel>
          <Button
            type="button"
            size="sm"
            variant={pending.kind === 'delete' ? 'destructive' : 'default'}
            onClick={onConfirm}
            autoFocus={!focusCancel}
            disabled={busy}
          >
            {pending.kind === 'delete'
              ? busy
                ? t('worktree.delete.deletingEllipsis', 'Deleting…')
                : t('auto.components.sidebar.DeleteCloudWorkspace.delete', 'Delete')
              : pending.kind === 'archive'
                ? busy
                  ? t('orcaCloudWorkspace.archiveNow.archiving', 'Archiving…')
                  : t('auto.components.cloudWorkspaces.archive', 'Archive')
                : busy
                  ? t('auto.components.cloudWorkspaces.ownerChange.changing', 'Changing owner…')
                  : t('auto.components.cloudWorkspaces.makeOwner', 'Make owner')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
