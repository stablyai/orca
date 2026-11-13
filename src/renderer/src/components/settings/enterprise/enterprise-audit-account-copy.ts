// Wording for the audit events the auth service and billing send: members and invites, the team
// itself, and the plan. (Workspace, key, secret and routine wording is in enterprise-audit-copy.)
import type { Translate } from '@/i18n/use-translate'

type Sentence = (t: Translate) => string
/** `named` takes the thing's name ({{name}}): a key, a secret, a teammate, a workspace. */
export type ActionCopy = { plain: Sentence; named?: (t: Translate, name: string) => string }

export const ACCOUNT_AUDIT_ACTIONS: Record<string, ActionCopy> = {
  'member.invited': {
    plain: (t) => t('settings.enterprise.audit.action.memberInvite', 'Invited a teammate'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.memberInviteNamed', 'Invited {{name}}', { name })
  },
  'member.invite_revoked': {
    plain: (t) => t('settings.enterprise.audit.action.inviteRevoke', 'Canceled an invite'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.inviteRevokeNamed', 'Canceled the invite for {{name}}', {
        name
      })
  },
  'member.removed': {
    plain: (t) => t('settings.enterprise.audit.action.memberRemove', 'Removed a teammate'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.memberRemoveNamed', 'Removed {{name}} from the team', {
        name
      })
  },
  'member.left': {
    plain: (t) => t('settings.enterprise.audit.action.memberLeft', 'Left the team')
  },
  'member.role_changed': {
    plain: (t) => t('settings.enterprise.audit.action.roleChange', 'Changed a teammate’s role'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.roleChangeNamed', 'Changed the role of {{name}}', {
        name
      })
  },
  'member.role_synced': {
    plain: (t) =>
      t(
        'settings.enterprise.audit.action.roleSync',
        'Updated a teammate’s API keys to match their role'
      )
  },
  'team.created': {
    plain: (t) => t('settings.enterprise.audit.action.teamCreate', 'Created the team')
  },
  'team.renamed': {
    plain: (t) => t('settings.enterprise.audit.action.teamRename', 'Renamed the team'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.teamRenameNamed', 'Renamed the team to “{{name}}”', {
        name
      })
  },
  'member.joined': {
    plain: (t) => t('settings.enterprise.audit.action.memberJoined', 'Joined the team')
  },
  'team.deleted': {
    plain: (t) => t('settings.enterprise.audit.action.teamDelete', 'Deleted the team')
  },
  // Billing. Stripe reports plan and seat changes, so those read without a subject (the person
  // column says Orca); overage and the spend cap are changed by a person in Plan & billing.
  'billing.plan_started': {
    plain: (t) => t('settings.enterprise.audit.action.planStarted', 'Plan started')
  },
  'billing.plan_changed': {
    plain: (t) => t('settings.enterprise.audit.action.planChanged', 'Plan changed')
  },
  'billing.plan_canceled': {
    plain: (t) => t('settings.enterprise.audit.action.planCanceled', 'Plan ended')
  },
  'billing.cancel_scheduled': {
    plain: (t) =>
      t('settings.enterprise.audit.action.cancelScheduled', 'Plan set to end at the next renewal')
  },
  'billing.cancel_reverted': {
    plain: (t) => t('settings.enterprise.audit.action.cancelReverted', 'Plan set to renew again')
  },
  'billing.seats_changed': {
    plain: (t) => t('settings.enterprise.audit.action.seatsChanged', 'Seats changed')
  },
  'billing.overage_enabled': {
    plain: (t) => t('settings.enterprise.audit.action.overageOn', 'Turned on overage')
  },
  'billing.overage_disabled': {
    plain: (t) => t('settings.enterprise.audit.action.overageOff', 'Turned off overage')
  },
  'billing.spend_cap_changed': {
    plain: (t) =>
      t('settings.enterprise.audit.action.spendCapChanged', 'Changed the overage spend cap')
  }
}
