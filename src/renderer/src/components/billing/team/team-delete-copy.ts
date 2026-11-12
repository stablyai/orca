// Words for deleting a team (TEAM-DELETE, design-squad). The body lists only what the delete
// really does: workspaces are never deleted by it, so any workspace blocks it instead.
import type { Translate } from '@/i18n/use-translate'
import type {
  OrcaOrgDeleteBlocker,
  OrcaProfileOrgDeleteResult
} from '../../../../../shared/orca-org-delete'

export type TeamDeleteBlockerLine = {
  code: OrcaOrgDeleteBlocker['code']
  text: string
  actionLabel: string
}

export function teamDeleteBlockerLines(
  blockers: readonly OrcaOrgDeleteBlocker[],
  t: Translate
): TeamDeleteBlockerLine[] {
  // The plan line first: it usually takes longest to clear.
  const ordered = [...blockers].sort((a, b) =>
    a.code === b.code ? 0 : a.code === 'subscription_active' ? -1 : 1
  )
  return ordered.map((blocker) =>
    blocker.code === 'subscription_active'
      ? {
          code: blocker.code,
          text: t(
            'auto.components.billing.team.delete.blockedPlan',
            'Your team still has a plan. Cancel it in billing first, then delete the team.'
          ),
          actionLabel: t('auto.components.billing.manageBilling', 'Manage billing')
        }
      : {
          code: blocker.code,
          text: t(
            'auto.components.billing.team.delete.blockedWorkspaces',
            '{{count}} cloud workspaces still exist. Delete them first.',
            {
              count: blocker.count,
              defaultValue_one: '{{count}} cloud workspace still exists. Delete it first.'
            }
          ),
          actionLabel: t(
            'auto.components.billing.team.delete.showWorkspaces',
            'Show cloud workspaces'
          )
        }
  )
}

export type TeamDeleteDialogError =
  /** Shown under the name field. */
  | { kind: 'mismatch'; text: string }
  /** Shown above the buttons; `blockers` repeats the card's lines (with their actions). */
  | { kind: 'blocked'; blockers: OrcaOrgDeleteBlocker[] }
  | { kind: 'message'; text: string }

/** Null for `deleted`; every failure keeps the dialog open with its reason. */
export function teamDeleteFailure(
  result: OrcaProfileOrgDeleteResult,
  t: Translate
): TeamDeleteDialogError | null {
  switch (result.status) {
    case 'deleted':
      return null
    case 'blocked':
      return result.blockers.length > 0
        ? { kind: 'blocked', blockers: result.blockers }
        : { kind: 'message', text: genericFailure(t) }
    case 'confirm-mismatch':
      return {
        kind: 'mismatch',
        text: t('auto.components.billing.team.delete.mismatch', 'The team name doesn’t match.')
      }
    case 'unavailable':
      return {
        kind: 'message',
        text: t(
          'auto.components.billing.team.delete.unavailable',
          'Couldn’t check the team right now, so nothing was deleted. Try again.'
        )
      }
    case 'rate-limited':
      return {
        kind: 'message',
        text: t(
          'auto.components.billing.team.delete.rateLimited',
          'Too many attempts. Wait a minute, then try again.'
        )
      }
    case 'forbidden':
      return {
        kind: 'message',
        text: t('auto.components.billing.team.delete.forbidden', 'Only owners can delete the team.')
      }
    case 'reconnect-required':
      return {
        kind: 'message',
        text: t(
          'auto.components.billing.openSignedOut2',
          'Sign in to Orca again to manage your team.'
        )
      }
    case 'unsupported':
    case 'unconfigured':
    case 'failed':
      return { kind: 'message', text: genericFailure(t) }
  }
}

function genericFailure(t: Translate): string {
  return t('auto.components.billing.team.delete.failed', 'Couldn’t delete the team. Try again.')
}
