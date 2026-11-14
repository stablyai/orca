// Mirrors Orca Cloud auth's role rules (apps/auth/src/accounts/org-roles.ts) so the UI only offers
// what the server will accept. Team management itself happens in the web console.
import type { Translate } from '@/i18n/use-translate'
import type { OrcaOrgRole } from '../../../../../shared/orca-profiles'

export function canManageMembers(role: OrcaOrgRole): boolean {
  return role === 'owner' || role === 'admin'
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
