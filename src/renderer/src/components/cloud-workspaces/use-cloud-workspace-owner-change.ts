// OWNER-TRANSFER: makes someone else the owner of a cloud workspace. The control plane puts the
// workspace to sleep first, so the confirmation stays open while it runs and shows a refusal in
// place; on success the person is told whether the previous owner will hear about it.
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { describeError } from './cloud-workspace-errors'
import { memberName, type MemberDirectory } from './cloud-workspace-format'
import { rememberCloudWorkspaces } from './cloud-workspace-identity'
import { ownerChangeRefusal, previousOwnerToast } from './owner-change-copy'
import {
  markNewOwnerNoticeSeen,
  refreshPreviousOwnerNoticesNow
} from './owner-change-notices-store'

/** Long enough to read two sentences about someone else's secrets. */
const TOLD_TOAST_MS = 12_000

export type OwnerChangeState = { busy: boolean; error: string | null }
const IDLE: OwnerChangeState = { busy: false, error: null }

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function useCloudWorkspaceOwnerChange({
  directory,
  selfId,
  replace,
  refresh
}: {
  directory: MemberDirectory
  selfId: string | null
  replace: (next: CloudWorkspace) => void
  refresh: () => void
}): {
  state: OwnerChangeState
  /** Resolves true once the owner changed. */
  run: (workspace: CloudWorkspace, ownerUserId: string) => Promise<boolean>
  reset: () => void
} {
  const t = useTranslate()
  const [state, setState] = useState<OwnerChangeState>(IDLE)
  const reset = useCallback(() => setState(IDLE), [])

  const run = useCallback(
    async (workspace: CloudWorkspace, ownerUserId: string): Promise<boolean> => {
      setState({ busy: true, error: null })
      const result = await window.api.cloudWorkspaces
        .changeOwner(workspace.id, ownerUserId)
        .catch(() => null)
      if (!result?.ok) {
        const error = result?.error ?? 'unavailable'
        const name = memberName(directory, ownerUserId, selfId, t)
        setState({
          busy: false,
          error:
            ownerChangeRefusal(error, result?.reason, name, t) ??
            describeError(error, result?.reason, t)
        })
        if (error === 'timeout') {
          // It may have landed after we stopped waiting: show what the control plane says now.
          refresh()
        }
        return false
      }
      setState(IDLE)
      const { workspace: next, previousOwner } = result.value
      replace(next)
      if (ownerUserId === selfId && next.ownershipTransferredAt != null) {
        // You took it yourself and just read what that means: no "you're now the owner" notice.
        markNewOwnerNoticeSeen(localStorageOrNull(), next.id, next.ownershipTransferredAt)
      }
      // The chip and the sidebar's hover card follow at once, not at the next poll.
      rememberCloudWorkspaces([next])
      const told = previousOwnerToast(
        previousOwner,
        selfId,
        previousOwner ? (directory.get(previousOwner.userId)?.name ?? null) : null,
        t
      )
      toast.success(
        t('auto.components.cloudWorkspaces.ownerChanged', 'Owner changed'),
        told ? { description: told, duration: TOLD_TOAST_MS } : undefined
      )
      if (previousOwner?.userId === selfId) {
        // You gave away your own: your notice (with the advice to rotate) is waiting.
        refreshPreviousOwnerNoticesNow()
      }
      refresh()
      return true
    },
    [directory, refresh, replace, selfId, t]
  )

  return { state, run, reset }
}
