// Deleting a team from Settings › Team (TEAM-DELETE): the card's pre-check, the typed-name
// dialog, and what happens after. Auth decides; this only explains its answer.
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Dialog } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import type {
  OrcaOrgDeleteBlocker,
  OrcaProfileOrgDeleteCheckResult,
  OrcaProfileOrgDeleteResult
} from '../../../../../shared/orca-org-delete'
import { openCloudWorkspacePicker } from '../../cloud-workspaces/cloud-workspace-picker-store'
import { TeamDeleteDialogView } from './TeamDeleteDialog'
import type { TeamDeleteCheck } from './TeamDeleteSection'
import {
  teamDeleteFailure,
  teamDeletePlanEndedText,
  type TeamDeleteDialogError
} from './team-delete-copy'

const RATE_LIMIT_WAIT_MS = 60_000

/**
 * EP-10: teams whose plan this window already ended in a delete that then failed. A retry's own
 * failure comes back as an ordinary code, but the plan is still gone: keep saying so.
 */
const planEndedTeams = new Set<string>()

/** Tests only. */
export function resetTeamDeletePlanEndedForTests(): void {
  planEndedTeams.clear()
}

/** Every failure after the plan already ended says so, whatever the retry's own cause. */
export function teamDeleteFailureAfterCancel(
  orgId: string,
  result: OrcaProfileOrgDeleteResult,
  failure: TeamDeleteDialogError | null,
  t: Parameters<typeof teamDeleteFailure>[1]
): TeamDeleteDialogError | null {
  if (result.status === 'failed-after-cancel') {
    planEndedTeams.add(orgId)
  }
  if (!failure || failure.kind === 'mismatch' || !planEndedTeams.has(orgId)) {
    return failure
  }
  return { kind: 'planEnded', text: teamDeletePlanEndedText(t) }
}

/** The card's state from the pre-check; null hides the card (not an owner, or no route yet). */
export function teamDeleteCheckFrom(
  result: OrcaProfileOrgDeleteCheckResult
): TeamDeleteCheck | null {
  switch (result.status) {
    case 'ok':
      return {
        state: 'ready',
        blockers: result.blockers,
        ...(result.cancelsSubscription ? { cancelsSubscription: result.cancelsSubscription } : {})
      }
    case 'unsupported':
    case 'forbidden':
    case 'unconfigured':
      return null
    case 'unavailable':
    case 'rate-limited':
    case 'reconnect-required':
    case 'failed':
      // Couldn't check: offer the delete anyway; auth checks again and the dialog explains.
      return { state: 'ready', blockers: [] }
  }
}

/** Every team workspace, archived ones too, so each can be deleted before the team. */
function showTeamWorkspaces(): void {
  openCloudWorkspacePicker({ kind: 'team-cleanup' })
}

export function useTeamDelete({
  orgId,
  teamName,
  enabled,
  onManageBilling,
  onDeleted
}: {
  orgId: string | null
  teamName: string
  /** Owners only. */
  enabled: boolean
  onManageBilling: () => void
  onDeleted: () => Promise<void>
}): {
  check: TeamDeleteCheck | null
  open: () => void
  dialog: React.JSX.Element | null
  onBlockerAction: (code: OrcaOrgDeleteBlocker['code']) => void
} {
  const t = useTranslate()
  const [check, setCheck] = useState<TeamDeleteCheck | null>(null)
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<TeamDeleteDialogError | null>(null)
  const [waiting, setWaiting] = useState(false)
  const waitTimer = useRef<number | null>(null)

  const runCheck = useCallback(() => {
    if (!enabled || !orgId) {
      setCheck(null)
      return () => {}
    }
    let cancelled = false
    setCheck((current) => current ?? { state: 'checking' })
    void window.api.orcaProfiles
      .orgDeleteCheck({ orgId })
      .catch((reason: unknown): OrcaProfileOrgDeleteCheckResult => ({
        status: 'failed',
        error: String(reason)
      }))
      .then((result) => {
        if (!cancelled) {
          setCheck(teamDeleteCheckFrom(result))
        }
      })
    return () => {
      cancelled = true
    }
  }, [enabled, orgId])

  // Checked when the card shows, and again on return (a plan cancelled or workspaces deleted elsewhere).
  useEffect(() => {
    let cancel = runCheck()
    const onFocus = (): void => {
      cancel()
      cancel = runCheck()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      cancel()
      window.removeEventListener('focus', onFocus)
    }
  }, [runCheck])

  useEffect(
    () => () => {
      if (waitTimer.current !== null) {
        window.clearTimeout(waitTimer.current)
      }
    },
    []
  )

  const close = (): void => {
    setOpen(false)
    setTyped('')
    setError(null)
  }

  const onBlockerAction = (code: OrcaOrgDeleteBlocker['code']): void => {
    close()
    if (code === 'subscription_active') {
      onManageBilling()
    } else {
      showTeamWorkspaces()
    }
  }

  const submit = (): void => {
    if (!orgId || submitting || waiting || typed !== teamName) {
      return
    }
    setSubmitting(true)
    setError(null)
    void window.api.orcaProfiles
      .orgDelete({ orgId, confirmName: typed })
      .catch((reason: unknown): OrcaProfileOrgDeleteResult => ({
        status: 'failed',
        error: String(reason)
      }))
      .then(async (result) => {
        setSubmitting(false)
        if (result.status === 'deleted') {
          planEndedTeams.delete(orgId)
          close()
          toast.success(
            t('auto.components.billing.team.delete.deletedToast2', '{{value0}} was deleted', {
              value0: teamName
            })
          )
          await onDeleted()
          return
        }
        if (result.status === 'blocked') {
          setCheck({ state: 'ready', blockers: result.blockers })
        }
        if (result.status === 'rate-limited') {
          setWaiting(true)
          waitTimer.current = window.setTimeout(() => setWaiting(false), RATE_LIMIT_WAIT_MS)
        }
        setError(teamDeleteFailureAfterCancel(orgId, result, teamDeleteFailure(result, t), t))
      })
  }

  const dialog = enabled ? (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) {
          close()
        }
      }}
    >
      {open ? (
        <TeamDeleteDialogView
          teamName={teamName}
          typed={typed}
          submitting={submitting}
          error={error}
          waiting={waiting}
          {...(check?.state === 'ready' && check.cancelsSubscription
            ? { cancelsSubscription: check.cancelsSubscription }
            : {})}
          onTypedChange={(value) => {
            setTyped(value)
            if (error?.kind === 'mismatch') {
              setError(null)
            }
          }}
          onCancel={close}
          onSubmit={submit}
          onBlockerAction={onBlockerAction}
        />
      ) : null}
    </Dialog>
  ) : null

  return { check, open: () => setOpen(true), dialog, onBlockerAction }
}
