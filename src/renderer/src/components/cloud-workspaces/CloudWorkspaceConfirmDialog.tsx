// Confirmation for the two row actions that take something away from people: making a shared
// workspace private (teammates' computers are disconnected) and handing ownership to someone else.
import React, { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
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

export type PendingConfirm =
  | { kind: 'private'; workspace: CloudWorkspace }
  | { kind: 'owner'; workspace: CloudWorkspace; ownerUserId: string }

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
        ? t('auto.components.cloudWorkspaces.makePrivateDisconnects', '{{names}} will be disconnected.', {
            names
          })
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
  onCancel,
  onConfirm
}: {
  pending: PendingConfirm
  directory: MemberDirectory
  selfId: string | null
  /** Team owner or admin: still manages every workspace after giving one away. */
  canAdmin: boolean
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
      : t('auto.components.cloudWorkspaces.reassignTitle', 'Make {{name}} the owner?', {
          name: memberName(directory, pending.ownerUserId, selfId, t)
        })
  const losesManagement = pending.kind === 'owner' && w.ownerUserId === selfId && !canAdmin
  return (
    <Dialog open onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {pending.kind === 'private' ? (
            <MakePrivateBody workspace={w} directory={directory} selfId={selfId} />
          ) : (
            <DialogDescription>
              {losesManagement
                ? t(
                    'auto.components.cloudWorkspaces.reassignLosesManagement',
                    "You won't be able to manage this workspace after this."
                  )
                : t(
                    'auto.components.cloudWorkspaces.reassignBody',
                    'They can then share, archive or hand it on.'
                  )}
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('auto.components.cloudWorkspaces.cancel', 'Cancel')}
          </Button>
          <Button type="button" onClick={onConfirm} autoFocus>
            {pending.kind === 'private'
              ? t('auto.components.cloudWorkspaces.makePrivate', 'Make private')
              : t('auto.components.cloudWorkspaces.makeOwner', 'Make owner')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
