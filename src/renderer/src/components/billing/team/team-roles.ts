// Mirrors Orca Cloud auth's role rules (apps/auth/src/accounts/org-roles.ts) so the UI only offers
// actions the server will accept: owner > admin > member; only owners act on owners.
import type { Translate } from '@/i18n/use-translate'
import type { OrcaOrgRole } from '../../../../../shared/orca-profiles'

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
