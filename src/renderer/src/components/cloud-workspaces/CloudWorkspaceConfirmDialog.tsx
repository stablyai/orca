// Confirmation for row actions that take something away from people: handing ownership to someone
// else, archiving a teammate's running workspace (their agents stop) and deleting one.
import { archiveDialogKeptLine } from '@/components/orca-cloud/archive-snapshot-copy'
import { useArchiveTtlDays } from '@/lib/orca-cloud/archive-ttl'
import type React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
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
  // Destructive for someone else (their agents stop, or you lose access): focus starts on Cancel.
  const focusCancel = losesManagement || pending.kind === 'archive' || pending.kind === 'delete'
  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent className="sm:max-w-md">
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
              <ul className="list-disc space-y-1 pl-5 text-left text-sm text-muted-foreground">
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
        {error ? <InlineError title={error} density="compact" /> : null}
        <DialogFooter>
          {/* Giving away your own access starts on Cancel, so Enter cannot do it by accident. */}
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            autoFocus={focusCancel}
            disabled={busy}
          >
            {t('auto.components.cloudWorkspaces.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant={pending.kind === 'delete' ? 'destructive' : 'default'}
            onClick={busy ? undefined : onConfirm}
            autoFocus={!focusCancel}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {pending.kind === 'delete'
              ? t('auto.components.sidebar.DeleteCloudWorkspace.delete', 'Delete')
              : pending.kind === 'archive'
                ? t('auto.components.cloudWorkspaces.archive', 'Archive')
                : busy
                  ? t('auto.components.cloudWorkspaces.ownerChange.changing', 'Changing owner…')
                  : t('auto.components.cloudWorkspaces.makeOwner', 'Make owner')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
