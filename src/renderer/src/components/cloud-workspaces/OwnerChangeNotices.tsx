// OWNER-TRANSFER: shows this member's owner-change notices as persistent cloud toasts while they
// are signed in to a team. A previous owner is told who took or gave away their workspace and to
// consider rotating personal secrets (amber, until dismissed); a new owner is told once that the
// workspace runs like a shared one (info).
import { useEffect, useMemo, useRef, useState } from 'react'
import { hideCloudToast, showCloudToast } from '@/components/orca-cloud/cloud-toast-stack'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { formatWorkspaceNumber } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { useOrgRoster } from '../billing/team/use-org-roster'
import { useCloudWorkspaceIdentities } from './cloud-workspace-identity'
import { newOwnerNotice, previousOwnerNotice, previousOwnerNoticeAction } from './owner-change-copy'
import {
  dismissPreviousOwnerNotice,
  markNewOwnerNoticeSeen,
  newOwnerWorkspaces,
  noticesForThisDevice,
  refreshPreviousOwnerNotices,
  usePreviousOwnerNotices
} from './owner-change-notices-store'

export const OWNER_NOTICE_POLL_MS = 60_000

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function openCloudSecrets(): void {
  const store = useAppStore.getState()
  store.openSettingsTarget({ pane: 'cloud-secrets', repoId: null })
  store.openSettingsPage()
}

function openNewCloudWorkspace(): void {
  useAppStore.getState().openModal('new-workspace-composer', {
    initialEphemeralVmRecipeId: ORCA_CLOUD_RECIPE_ID,
    telemetrySource: 'unknown'
  })
}

export function OwnerChangeNotices(): null {
  const t = useTranslate()
  const cloud = useAppStore((state) => state.orcaProfileAuthStatus?.cloud)
  const selfId = cloud?.userId ?? null
  const orgId = cloud?.activeOrgId ?? null
  // Teams only: a personal account has nobody to hand a workspace to.
  const accountKey = selfId && orgId ? `${selfId}:${orgId}` : null
  const notices = usePreviousOwnerNotices(accountKey)
  const identities = useCloudWorkspaceIdentities()
  const roster = useOrgRoster(orgId)
  // Bumped when a new-owner notice is closed, so the list is worked out again without it.
  const [closed, setClosed] = useState(0)
  const shown = useRef(new Set<string>())

  useEffect(() => {
    if (!accountKey) {
      void refreshPreviousOwnerNotices(null)
      return
    }
    void refreshPreviousOwnerNotices(accountKey)
    return installWindowVisibilityInterval({
      run: () => void refreshPreviousOwnerNotices(accountKey),
      intervalMs: OWNER_NOTICE_POLL_MS,
      slowWhileUnfocused: true
    })
  }, [accountKey])

  const rosterNames = useMemo(() => {
    const names = new Map<string, string>()
    if (roster.result?.status === 'ok') {
      for (const member of roster.result.roster.members) {
        if (member.userId) {
          names.set(member.userId, member.displayName || member.email)
        }
      }
    }
    return names
  }, [roster.result])

  useEffect(() => {
    const next = new Set<string>()
    for (const notice of noticesForThisDevice(notices, selfId, localStorageOrNull())) {
      const id = `owner-change:${notice.id}`
      next.add(id)
      const copy = previousOwnerNotice(
        notice,
        selfId,
        (userId) => rosterNames.get(userId) ?? null,
        t
      )
      showCloudToast(
        id,
        {
          priority: 'warning',
          lines: [
            {
              key: notice.id,
              text: copy.text,
              description: copy.description,
              action: { label: previousOwnerNoticeAction(t), onClick: openCloudSecrets }
            }
          ]
        },
        { onDismiss: () => dismissPreviousOwnerNotice(notice.id) }
      )
    }
    const mine = accountKey
      ? newOwnerWorkspaces(identities.bySandbox, selfId, Date.now(), localStorageOrNull())
      : []
    for (const workspace of mine) {
      const id = `new-owner:${workspace.sandboxId}:${workspace.transferredAt}`
      next.add(id)
      const number = identities.bySandbox.get(workspace.sandboxId)?.number
      const copy = newOwnerNotice(
        workspace.title?.trim().slice(0, 80) ||
          (number ? formatWorkspaceNumber(number) : '') ||
          t('auto.components.cloudWorkspaces.ownerChange.aWorkspace', 'a workspace'),
        t
      )
      const seen = (): void => {
        markNewOwnerNoticeSeen(localStorageOrNull(), workspace.sandboxId, workspace.transferredAt)
        setClosed((count) => count + 1)
      }
      showCloudToast(
        id,
        {
          priority: 'info',
          lines: [
            {
              key: workspace.sandboxId,
              text: copy.text,
              description: copy.description,
              action: {
                label: copy.action,
                onClick: () => {
                  seen()
                  openNewCloudWorkspace()
                }
              }
            }
          ]
        },
        { onDismiss: seen }
      )
    }
    for (const id of shown.current) {
      if (!next.has(id)) {
        hideCloudToast(id)
      }
    }
    shown.current = next
  }, [accountKey, closed, identities.bySandbox, notices, rosterNames, selfId, t])

  // Signing out or closing the window takes them down with the component.
  useEffect(() => {
    const ids = shown
    return () => {
      ids.current.forEach((id) => hideCloudToast(id))
      ids.current = new Set()
    }
  }, [])

  return null
}
