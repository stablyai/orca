// Team page copy that more than one component needs.
import type { OrcaProfileOrgCreateResult } from '../../../../../shared/orca-org-management'
import type { Translate } from '@/i18n/use-translate'
import type {
  OrcaOrgRole,
  OrcaProfileOrgMemberMutationResult
} from '../../../../../shared/orca-profiles'

// i18next plurals (`_one` / `_other` in the catalogs), never ternaries.
export function seatCountLabel(count: number, t: Translate): string {
  return t('auto.components.billing.team.seatCount', '{{count}} seats', {
    count,
    defaultValue_one: '{{count}} seat'
  })
}

export function memberCountLabel(count: number, t: Translate): string {
  return t('auto.components.billing.team.memberCount', '{{count}} members', {
    count,
    defaultValue_one: '{{count}} member'
  })
}

/** "Invited 2 days ago as an admin": one key per role, so no lowercased labels in sentences. */
export function invitedAsCopy(role: OrcaOrgRole, when: string, t: Translate): string {
  switch (role) {
    case 'owner':
      return t('auto.components.billing.team.invitedAsOwner', 'Invited {{value0}} as an owner', {
        value0: when
      })
    case 'admin':
      return t('auto.components.billing.team.invitedAsAdmin', 'Invited {{value0}} as an admin', {
        value0: when
      })
    case 'member':
      return t('auto.components.billing.team.invitedAsMember', 'Invited {{value0}} as a member', {
        value0: when
      })
  }
}

export function roleChangedCopy(name: string, role: OrcaOrgRole, t: Translate): string {
  switch (role) {
    case 'owner':
      return t('auto.components.billing.team.nowOwner', '{{value0}} is now an owner', {
        value0: name
      })
    case 'admin':
      return t('auto.components.billing.team.nowAdmin', '{{value0}} is now an admin', {
        value0: name
      })
    case 'member':
      return t('auto.components.billing.team.nowMember', '{{value0}} is now a member', {
        value0: name
      })
  }
}

export function roleDescription(role: OrcaOrgRole, t: Translate): string {
  switch (role) {
    case 'owner':
      return t(
        'auto.components.billing.team.roleOwnerHint',
        'Everything, including billing and other owners'
      )
    case 'admin':
      return t('auto.components.billing.team.roleAdminHint', 'Manages members and billing')
    case 'member':
      return t('auto.components.billing.team.roleMemberHint', 'Uses Orca Cloud with the team')
  }
}

/** Status of a roster entry: signed in, invited (email sent), or added but never signed in. */
export type TeamMemberStatus = 'active' | 'invited' | 'pending'

export function memberStatusLabel(status: TeamMemberStatus, t: Translate): string {
  switch (status) {
    case 'active':
      return t('auto.components.billing.team.statusActive', 'Active')
    case 'invited':
      return t('auto.components.billing.team.statusInvited', 'Invited')
    case 'pending':
      return t('auto.components.billing.team.statusPending', 'Pending sign-in')
  }
}

export function mutationFailureCopy(
  result: OrcaProfileOrgMemberMutationResult,
  t: Translate
): string | null {
  switch (result.status) {
    case 'ok':
      return null
    case 'conflict':
      return result.reason === 'already_member'
        ? t('auto.components.billing.team.alreadyMember', 'That person is already a member.')
        : t('auto.components.billing.team.alreadyInvited', 'That person already has an invite.')
    case 'invalid':
      switch (result.reason) {
        case 'cannot_remove_self':
          return t(
            'auto.components.billing.team.cannotRemoveSelf',
            'Use Leave team to remove yourself.'
          )
        case 'last_owner':
          return t(
            'auto.components.billing.team.lastOwner',
            'Make someone else an owner before you leave.'
          )
        case 'cannot_change_own_role':
          return t(
            'auto.components.billing.team.cannotChangeOwnRole',
            'Another owner has to change your role.'
          )
      }
      return null
    case 'forbidden':
      return t(
        'auto.components.billing.team.forbidden',
        'Only owners and admins can manage members, and only owners can manage owners.'
      )
    case 'not-found':
      return t('auto.components.billing.team.notFound', 'That member or invite no longer exists.')
    case 'unsupported':
      return t(
        'auto.components.billing.team.unsupported2',
        'This isn’t available yet. Ask an owner or admin to do it for you.'
      )
    case 'rate-limited':
      return t(
        'auto.components.billing.team.rateLimited',
        'Too many team changes at once. Wait a minute and try again.'
      )
    case 'reconnect-required':
      return t(
        'auto.components.billing.openSignedOut2',
        'Sign in to Orca again to manage your team.'
      )
    case 'unconfigured':
      return t('auto.components.billing.openUnconfigured', 'Billing is unavailable in this build.')
    case 'failed':
      return t('auto.components.billing.team.failed', 'Could not update the team. Try again.')
  }
}

export function createTeamFailureCopy(
  result: OrcaProfileOrgCreateResult,
  t: Translate
): string | null {
  switch (result.status) {
    case 'created':
      return null
    case 'invalid':
      return t(
        'auto.components.billing.team.createInvalid2',
        'Use letters, numbers, spaces or underscores (up to 64).'
      )
    case 'name-taken':
      return t('auto.components.billing.team.nameTaken', 'That team name is taken. Try another.')
    case 'unsupported':
      return t(
        'auto.components.billing.team.createUnavailable',
        'Team creation isn’t available yet. Ask a teammate to invite you.'
      )
    case 'rate-limited':
      return t(
        'auto.components.billing.team.rateLimited',
        'Too many team changes at once. Wait a minute and try again.'
      )
    case 'reconnect-required':
      return t(
        'auto.components.billing.openSignedOut2',
        'Sign in to Orca again to manage your team.'
      )
    case 'unconfigured':
      return t('auto.components.billing.openUnconfigured', 'Billing is unavailable in this build.')
    case 'failed':
      return t('auto.components.billing.team.createFailed', 'Could not create the team. Try again.')
  }
}
