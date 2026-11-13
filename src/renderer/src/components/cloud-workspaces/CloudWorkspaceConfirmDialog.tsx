// Confirmation for row actions that take something away from people: making a shared workspace
// private (teammates' computers are disconnected), handing ownership to someone else, and archiving
// a teammate's running workspace (their agents stop).
import { useArchiveSnapshotDefinition } from '@/components/orca-cloud/ArchiveSnapshotTooltip'
import React, { useEffect, useState } from 'react'
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
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { formatNameList, memberName, type MemberDirectory } from './cloud-workspace-format'
import { cloudWorkspaceTitle } from './open-cloud-workspace'
import { ownerChangeConsequences } from './owner-change-copy'

export type PendingConfirm =
  | { kind: 'private'; workspace: CloudWorkspace }
  | { kind: 'owner'; workspace: CloudWorkspace; ownerUserId: string }
  /** Archiving a teammate's running workspace stops their agents. */
  | { kind: 'archive'; workspace: CloudWorkspace }
  /** Deleting from the team list: the sandbox and its disk go (DS-07 copy). */
  | { kind: 'delete'; workspace: CloudWorkspace }

/** Teammates who would lose access: here now, or holding an active device grant. */
function useConnectedTeammates(workspace: CloudWorkspace, selfId: string | null): string[] {
  const here = workspace.presence.map((p) => p.userId)
  const [granted, setGranted] = useState<string[]>([])
  useEffect(() => {
    let disposed = false
    void window.api.cloudWorkspaces
      .listGrants(workspace.id)
      .then((result) => {
        if (!disposed && result.ok) {
          setGranted(result.value.filter((g) => g.status === 'active').map((g) => g.userId))
        }
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [workspace.id])
  // The owner keeps access, and so do you (you are the one making the change).
  return [...new Set([...here, ...granted])].filter(
    (userId) => userId !== selfId && userId !== workspace.ownerUserId
  )
}

function MakePrivateBody({
  workspace,
  directory,
  selfId
}: {
  workspace: CloudWorkspace
  directory: MemberDirectory
  selfId: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const connected = useConnectedTeammates(workspace, selfId)
  const names = formatNameList(
    connected.map((userId) => memberName(directory, userId, selfId, t)),
    intlLocale
  )
  return (
    <DialogDescription>
      {connected.length > 0
        ? t(
            'auto.components.cloudWorkspaces.makePrivateDisconnects',
            '{{names}} will be disconnected.',
            {
              names
            }
          )
        : t(
            'auto.components.cloudWorkspaces.makePrivateNobody',
            'No teammates are connected right now. Only the owner will be able to open it.'
          )}
    </DialogDescription>
  )
}

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
  /** OWNER-TRANSFER: the change is being made (the workspace goes to sleep first, so it takes a while). */
  busy?: boolean
  /** Why the last try changed nothing, shown in place so the person can try again. */
  error?: string | null
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const w = pending.workspace
  const title =
    pending.kind === 'private'
      ? t('auto.components.cloudWorkspaces.makePrivateTitle', 'Make {{title}} private?', {
          title: cloudWorkspaceTitle(w, t)
        })
      : pending.kind === 'archive' || pending.kind === 'delete'
        ? pending.kind === 'archive'
          ? t('auto.components.cloudWorkspaces.archiveConfirmTitle', 'Archive {{name}}?', {
              name: cloudWorkspaceTitle(w, t)
            })
          : t('auto.components.cloudWorkspaces.deleteConfirmTitle', 'Delete {{name}}?', {
              name: cloudWorkspaceTitle(w, t)
            })
        : t('auto.components.cloudWorkspaces.reassignTitle', 'Make {{name}} the owner?', {
            name: memberName(directory, pending.ownerUserId, selfId, t)
          })
  // What archive keeps, until when, and that it costs no sandbox hours (one shared definition).
  const archiveDefinition = useArchiveSnapshotDefinition()
  const losesManagement = pending.kind === 'owner' && w.ownerUserId === selfId && !canAdmin
  // Destructive for someone else (their agents stop, or you lose access): focus starts on Cancel.
  const focusCancel = losesManagement || pending.kind === 'archive' || pending.kind === 'delete'
  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {pending.kind === 'private' ? (
            <MakePrivateBody workspace={w} directory={directory} selfId={selfId} />
          ) : pending.kind === 'delete' ? (
            <DialogDescription>
              {t(
                'auto.components.sidebar.DeleteCloudWorkspace.bodyNoSnapshot',
                "Deletes the sandbox and its disk, including chats, terminals and uncommitted changes. This can't be undone."
              )}
            </DialogDescription>
          ) : pending.kind === 'archive' ? (
            <DialogDescription>
              {t(
                'auto.components.cloudWorkspaces.archiveConfirmStops',
                "{{owner}}'s agents in this workspace will stop.",
                { owner: memberName(directory, w.ownerUserId, selfId, t) }
              )}{' '}
              {archiveDefinition}
            </DialogDescription>
          ) : (
            <>
              {/* OWNER-TRANSFER: what the change does, before who manages it afterwards. */}
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
                      'They can then change who can see it, archive it or make someone else the owner.'
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
            {pending.kind === 'private'
              ? t('auto.components.cloudWorkspaces.makePrivate', 'Make private')
              : pending.kind === 'delete'
                ? t('auto.components.sidebar.DeleteCloudWorkspace.delete', 'Delete workspace')
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
