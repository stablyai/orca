// Mirrors Orca Cloud auth's role rules (apps/auth/src/accounts/org-roles.ts) so the UI only offers
// actions the server will accept: owner > admin > member; only owners act on owners.
import type { Translate } from '@/i18n/use-translate'
import type {
  OrcaOrgRole,
  OrcaProfileOrgMemberMutationResult
} from '../../../../../shared/orca-profiles'

export const ORG_ROLES: readonly OrcaOrgRole[] = ['owner', 'admin', 'member']

export function canManageMembers(role: OrcaOrgRole): boolean {
  return role === 'owner' || role === 'admin'
}

export function canActOnRole(actor: OrcaOrgRole, target: OrcaOrgRole): boolean {
  if (!canManageMembers(actor)) {
    return false
  }
  return target !== 'owner' || actor === 'owner'
}

/** Roles the viewer may assign (to an invite or an existing member). */
export function assignableRoles(actor: OrcaOrgRole): OrcaOrgRole[] {
  return ORG_ROLES.filter((role) => canActOnRole(actor, role))
}

export function roleLabel(role: OrcaOrgRole, t: Translate): string {
  switch (role) {
    case 'owner':
      return t('auto.components.billing.team.roleOwner', 'Owner')
    case 'admin':
      return t('auto.components.billing.team.roleAdmin', 'Admin')
    case 'member':
      return t('auto.components.billing.team.roleMember', 'Member')
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
      return result.reason === 'cannot_remove_self'
        ? t('auto.components.billing.team.cannotRemoveSelf', 'You cannot remove yourself.')
        : t('auto.components.billing.team.cannotChangeOwnRole', 'You cannot change your own role.')
    case 'forbidden':
      return t(
        'auto.components.billing.team.forbidden',
        'Only owners and admins can manage members, and only owners can manage owners.'
      )
    case 'not-found':
      return t('auto.components.billing.team.notFound', 'That member or invite no longer exists.')
    case 'reconnect-required':
      return t('auto.components.billing.openSignedOut', 'Sign in to Orca again to manage billing.')
    case 'unconfigured':
      return t('auto.components.billing.openUnconfigured', 'Billing is unavailable in this build.')
    case 'failed':
      return t('auto.components.billing.team.failed', 'Could not update the team. Try again.')
  }
}
