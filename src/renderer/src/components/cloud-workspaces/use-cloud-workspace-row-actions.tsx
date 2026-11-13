// What a cloud workspace row can do from "Open cloud workspace…": open (or read an Asleep one's
// saved copy), copy its link, share or hand it over, sleep, archive and delete. Opening goes through
// openCloudWorkspace, the same path as a workspace link and a teammate's profile.
import React, { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { refreshCloudMessageSenders } from '@/lib/cloud-message-sender'
import type {
  CloudWorkspace,
  CloudWorkspacePatch,
  CloudWorkspacePresence
} from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { useOrgRoster } from '../billing/team/use-org-roster'
import type { MemberDirectory } from './cloud-workspace-format'
import { describeError } from './cloud-workspace-errors'
import { focusCloudChat } from './cloud-chat-focus'
import * as archive from './cloud-workspace-home-archive'
import { focusedKind, frontCloudChat } from './cloud-workspace-links'
import { copyCloudWorkspaceLink, openCloudWorkspace } from './open-cloud-workspace'
import type { RowActions } from './CloudWorkspaceRowMenu'
import { CloudWorkspaceConfirmDialog, type PendingConfirm } from './CloudWorkspaceConfirmDialog'
import { CloudReadSnapshotSheet } from './CloudReadSnapshotSheet'
import { useCloudReadPanel } from './use-cloud-read-panel'
import { toastSharedWithTeam } from './shared-with-team-toast'

/** Names for every member id the rows show, and whether you are a team owner or admin. */
export function useMemberDirectory(
  orgId: string | undefined,
  workspaces: readonly CloudWorkspace[]
): { directory: MemberDirectory; canAdmin: boolean } {
  const roster = useOrgRoster(orgId ?? '')
  return useMemo(() => {
    const directory: MemberDirectory = new Map()
    let canAdmin = false
    if (orgId && roster.result?.status === 'ok') {
      for (const m of roster.result.roster.members) {
        if (m.userId) {
          directory.set(m.userId, { name: m.displayName || m.email, email: m.email })
        }
      }
      canAdmin =
        roster.result.roster.viewerRole === 'owner' || roster.result.roster.viewerRole === 'admin'
    }
    // Ids the roster does not cover (still loading, a dev org, a member who left) fall back to the
    // name each member's own token carries, as the control plane reports it.
    for (const w of workspaces) {
      for (const [userId, name] of Object.entries(w.memberNames ?? {})) {
        if (name && !directory.has(userId)) {
          directory.set(userId, { name, email: null })
        }
      }
    }
    return { directory, canAdmin }
  }, [orgId, roster.result, workspaces])
}

export function useCloudWorkspaceRowActions({
  workspaces,
  directory,
  selfId,
  canAdmin,
  refresh,
  replace,
  onOpened
}: {
  /** The listed rows: the read-only sheet follows its row as polling refreshes it. */
  workspaces: readonly CloudWorkspace[]
  directory: MemberDirectory
  selfId: string | null
  canAdmin: boolean
  refresh: () => void
  replace: (next: CloudWorkspace) => void
  /** It opened in the sidebar: the picker closes. */
  onOpened: () => void
}): { actions: RowActions; openingId: string | null; dialogs: React.JSX.Element } {
  const t = useTranslate()
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const { readingId, readingRef, setReadingId, readWake, setReadWake } = useCloudReadPanel()

  /** Opens the workspace, then (going to a teammate's chat) the chat they have in front. */
  const open = useCallback(
    async (w: CloudWorkspace, chatId?: string | null) => {
      setOpeningId(w.id)
      const fromPanel = readingRef.current === w.id
      if (fromPanel) {
        setReadWake({ phase: 'waking', startedAt: Date.now() })
      }
      try {
        const outcome = await openCloudWorkspace(w)
        if (!outcome.ok) {
          if (fromPanel && readingRef.current === w.id) {
            // The panel shows the failure in place (with the reason) instead of a toast.
            setReadWake({ ...outcome, phase: 'failed' })
          } else {
            toast.error(outcome.message)
          }
          return
        }
        setReadingId((current) => (current === w.id ? null : current))
        onOpened()
        if (chatId) {
          await focusCloudChat(outcome.worktreeId, chatId)
        }
      } finally {
        setOpeningId((current) => (current === w.id ? null : current))
      }
    },
    [onOpened, readingRef, setReadWake, setReadingId]
  )

  const patch = useCallback(
    async (w: CloudWorkspace, change: CloudWorkspacePatch, confirmed = false) => {
      // Making private and handing over ownership take access away; both ask first.
      if (!confirmed && change.visibility === 'private') {
        setConfirm({ kind: 'private', workspace: w })
        return
      }
      if (!confirmed && change.ownerUserId) {
        setConfirm({ kind: 'owner', workspace: w, ownerUserId: change.ownerUserId })
        return
      }
      const result = await window.api.cloudWorkspaces.patch(w.id, change)
      if (!result.ok) {
        toast.error(describeError(result.error, result.reason, t))
        return
      }
      replace(result.value)
      if (change.visibility !== undefined) {
        // Shared or private changes whether messages there carry the sender line.
        void refreshCloudMessageSenders().catch(() => undefined)
      }
      if (change.visibility === 'team') {
        toastSharedWithTeam(t)
      } else if (change.visibility === 'private') {
        toast.success(
          t(
            'auto.components.cloudWorkspaces.nowPrivate',
            'Now private. Teammates’ devices were disconnected.'
          )
        )
      } else if (change.ownerUserId) {
        toast.success(t('auto.components.cloudWorkspaces.ownerChanged', 'Owner changed'))
      }
      refresh()
    },
    [refresh, replace, t]
  )

  const actions = useMemo<RowActions>(
    () => ({
      open: (w) => void open(w),
      read: (w) => setReadingId(w.id),
      copyLink: (w) => void copyCloudWorkspaceLink(w.id),
      copyWorkspaceLink: (w) => {
        const front = frontCloudChat()
        if (front?.sandboxId === w.id && front.chatId) {
          void copyCloudWorkspaceLink(w.id, front.chatId)
        }
      },
      focusedItem: (w) => {
        const front = frontCloudChat()
        return front?.sandboxId === w.id ? focusedKind(front.chatId) : null
      },
      goToChat: (w: CloudWorkspace, member: CloudWorkspacePresence) => void open(w, member.chatId),
      patch: (w, change) => void patch(w, change),
      ...archive.homeArchiveActions({ selfId, t, refresh, confirmArchive: setConfirm })
    }),
    [open, patch, refresh, selfId, setReadingId, t]
  )

  const dialogs = (
    <>
      <CloudReadSnapshotSheet
        // The listed row (refreshed by polling) so a wake elsewhere shows up; gone rows close it.
        workspace={readingId ? (workspaces.find((w) => w.id === readingId) ?? null) : null}
        wake={readWake}
        onWake={(w) => void open(w)}
        onClose={() => setReadingId(null)}
      />
      {confirm && (
        <CloudWorkspaceConfirmDialog
          pending={confirm}
          directory={directory}
          selfId={selfId}
          canAdmin={canAdmin}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            if (confirm.kind === 'archive' || confirm.kind === 'delete') {
              setConfirm(null)
              archive.runConfirmed(confirm, t, refresh)
              return
            }
            const change: CloudWorkspacePatch =
              confirm.kind === 'private'
                ? { visibility: 'private' }
                : { ownerUserId: confirm.ownerUserId }
            setConfirm(null)
            void patch(confirm.workspace, change, true)
          }}
        />
      )}
    </>
  )

  return { actions, openingId, dialogs }
}
