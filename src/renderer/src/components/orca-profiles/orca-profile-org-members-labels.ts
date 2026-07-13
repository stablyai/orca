import { translate } from '@/i18n/i18n'
import type {
  OrcaOrgRole,
  OrcaProfileOrgMemberMutationResult
} from '../../../../shared/orca-profiles'

export const ORG_ROLE_OPTIONS: readonly OrcaOrgRole[] = ['owner', 'admin', 'member']

export function orgRoleLabel(role: OrcaOrgRole): string {
  switch (role) {
    case 'owner':
      return translate('auto.components.orca.profiles.org.members.role.owner', 'Owner')
    case 'admin':
      return translate('auto.components.orca.profiles.org.members.role.admin', 'Admin')
    case 'member':
      return translate('auto.components.orca.profiles.org.members.role.member', 'Member')
  }
}

export function orgMemberInitials(displayName: string | undefined, email: string): string {
  const source = displayName?.trim() || email.trim()
  if (!source) {
    return '?'
  }
  const words = source.split(/\s+/).filter(Boolean)
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase()
  }
  return source.slice(0, 2).toUpperCase()
}

// Why: the dialog maps every non-ok mutation status to a precise, translated
// message so managers see why an action was rejected instead of a raw code.
export function describeOrgMutationError(
  result: Exclude<OrcaProfileOrgMemberMutationResult, { status: 'ok' }>
): string {
  switch (result.status) {
    case 'forbidden':
      return translate(
        'auto.components.orca.profiles.org.members.error.forbidden',
        "Your role can't do that."
      )
    case 'conflict':
      return translate(
        'auto.components.orca.profiles.org.members.error.conflict',
        'Already a member or invited.'
      )
    case 'invalid':
      return result.reason === 'cannot_remove_self'
        ? translate(
            'auto.components.orca.profiles.org.members.error.remove.self',
            "You can't remove yourself."
          )
        : translate(
            'auto.components.orca.profiles.org.members.error.own.role',
            "You can't change your own role."
          )
    case 'not-found':
      return translate(
        'auto.components.orca.profiles.org.members.error.not.found',
        'That teammate is no longer in this organization.'
      )
    case 'reconnect-required':
      return translate(
        'auto.components.orca.profiles.org.members.error.reconnect',
        'Reconnect your profile to manage members.'
      )
    case 'unconfigured':
      return translate(
        'auto.components.orca.profiles.org.members.error.unconfigured',
        'Organization management is unavailable in this build.'
      )
    case 'failed':
      return translate(
        'auto.components.orca.profiles.org.members.error.failed',
        'Something went wrong. Please try again.'
      )
  }
}
