// Leaving a team: the confirmation the ⋯ menu on your own row opens, and why it can be blocked.
// The Team page has no separate "Leave team" row; the menu is the one way in.
import type { ConfirmationDialogOptions } from '@/components/confirmation-dialog-context'
import type { Translate } from '@/i18n/use-translate'

export function leaveTeamConfirmation(teamName: string, t: Translate): ConfirmationDialogOptions {
  return {
    title: t('auto.components.billing.team.leaveConfirmTitle', 'Leave {{value0}}?', {
      value0: teamName
    }),
    description: t(
      'auto.components.billing.team.leaveBody2',
      'You lose access to the team’s cloud workspaces and secrets. An owner or admin can invite you back.'
    ),
    confirmLabel: t('auto.components.billing.team.leaveCta', 'Leave team'),
    confirmVariant: 'destructive',
    // Leaving is the destructive choice; Enter on open must not take it.
    initialFocus: 'cancel'
  }
}

/**
 * Why the viewer can't leave, or null when they can. The last owner is blocked outright (never a
 * confirm that then fails): someone else has to own the team first, or the team is deleted.
 */
export function leaveBlockedReason(
  args: { canLeave: boolean; canDeleteTeam: boolean },
  t: Translate
): string | null {
  if (args.canLeave) {
    return null
  }
  return args.canDeleteTeam
    ? t(
        'auto.components.billing.team.leaveLastOwnerOrDelete',
        'You’re the only owner. Make someone else an owner first, or delete the team.'
      )
    : t(
        'auto.components.billing.team.leaveLastOwner',
        'You’re the only owner. Make someone else an owner first.'
      )
}
