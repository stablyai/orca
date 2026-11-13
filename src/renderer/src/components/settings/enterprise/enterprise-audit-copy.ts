// Wording for the team audit log: each recorded action as a sentence an admin can scan, and the
// names of the categories they filter by. An action this version does not know is shown by its
// machine name rather than hidden, so nothing recorded is ever missing from the log.
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type {
  CloudAuditCategory,
  CloudAuditEvent
} from '../../../../../shared/cloud-api/cloud-api-types'
import { ACCOUNT_AUDIT_ACTIONS, type ActionCopy } from './enterprise-audit-account-copy'
import { WORKSPACE_AUDIT_ACTIONS } from './enterprise-audit-workspace-copy'
import { SSO_AUDIT_ACTIONS } from './enterprise-audit-sso-copy'

export function auditCategoryLabel(category: CloudAuditCategory, t: Translate = translate): string {
  switch (category) {
    case 'members':
      return t('settings.enterprise.audit.category.members', 'Members')
    case 'security':
      return t('settings.enterprise.audit.category.security', 'Security')
    case 'api_keys':
      return t('settings.enterprise.audit.category.apiKeys', 'API keys')
    case 'apps':
      return t('settings.enterprise.audit.category.apps', 'Connected apps')
    case 'workspaces':
      return t('settings.enterprise.audit.category.workspaces', 'Workspaces')
    case 'secrets':
      return t('settings.enterprise.audit.category.secrets', 'Secrets')
    case 'routines':
      return t('settings.enterprise.audit.category.routines', 'Routines')
    case 'settings':
      return t('settings.enterprise.audit.category.settings', 'Settings')
    case 'billing':
      return t('settings.enterprise.audit.category.billing', 'Billing')
    case 'other':
      return t('settings.enterprise.audit.category.other', 'Other')
  }
}

const ACTIONS: Record<string, ActionCopy> = {
  'api_key.create': {
    plain: (t) => t('auto.components.settings.cloudApi.audit.action.keyCreate', 'Created API key'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.keyCreateNamed', 'Created API key “{{name}}”', { name })
  },
  'api_key.revoke': {
    plain: (t) => t('auto.components.settings.cloudApi.audit.action.keyRevoke', 'Revoked API key'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.keyRevokeNamed', 'Revoked API key “{{name}}”', { name })
  },
  'workspace_token.issue': {
    plain: (t) =>
      t('settings.enterprise.audit.action.workspaceToken', 'Gave an agent access to the Orca API')
  },
  'settings.update': {
    plain: (t) =>
      t('auto.components.settings.cloudApi.audit.action.settings', 'Changed agent access')
  },
  'project.create': {
    plain: (t) =>
      t('auto.components.settings.cloudApi.audit.action.projectCreate', 'Created a project'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.projectCreateNamed', 'Created project “{{name}}”', {
        name
      })
  },
  'project.update': {
    plain: (t) =>
      t('auto.components.settings.cloudApi.audit.action.projectUpdate', 'Edited a project')
  },
  'project.delete': {
    plain: (t) =>
      t('auto.components.settings.cloudApi.audit.action.projectDelete', 'Deleted a project')
  },
  'mcp.approval_create': {
    plain: (t) =>
      t('auto.components.settings.cloudApi.audit.action.approval', 'Made an app approval code')
  },
  'mcp.authorize': {
    plain: (t) => t('settings.enterprise.audit.action.mcpAuthorize', 'Connected an app')
  },
  'mcp.grant_revoke': {
    plain: (t) => t('settings.enterprise.audit.action.mcpRevoke', 'Disconnected an app')
  },
  'mcp.code_replay': {
    plain: (t) =>
      t(
        'settings.enterprise.audit.action.mcpCodeReplay',
        'Blocked a reused app sign-in code and disconnected the app'
      )
  },
  'mcp.refresh_replay': {
    plain: (t) =>
      t(
        'settings.enterprise.audit.action.mcpRefreshReplay',
        'Blocked a reused app token and disconnected the app'
      )
  },
  'secret.created': {
    plain: (t) => t('settings.enterprise.audit.action.secretCreate', 'Added a secret'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.secretCreateNamed', 'Added secret {{name}}', { name })
  },
  'secret.updated': {
    plain: (t) => t('settings.enterprise.audit.action.secretUpdate', 'Changed a secret'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.secretUpdateNamed', 'Changed secret {{name}}', { name })
  },
  'secret.deleted': {
    plain: (t) => t('settings.enterprise.audit.action.secretDelete', 'Deleted a secret'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.secretDeleteNamed', 'Deleted secret {{name}}', { name })
  },
  ...ACCOUNT_AUDIT_ACTIONS,
  ...SSO_AUDIT_ACTIONS,
  'mfa.policy.enabled': {
    plain: (t) =>
      t('settings.enterprise.audit.action.mfaPolicyEnabled', 'Required two-factor authentication')
  },
  'mfa.policy.changed': {
    plain: (t) =>
      t(
        'settings.enterprise.audit.action.mfaPolicyChanged',
        'Changed the two-factor authentication date'
      )
  },
  'mfa.policy.disabled': {
    plain: (t) =>
      t(
        'settings.enterprise.audit.action.mfaPolicyDisabled',
        'Stopped requiring two-factor authentication'
      )
  },
  'mfa.reminder.resent': {
    plain: (t) =>
      t(
        'settings.enterprise.audit.action.mfaReminderResent',
        'Sent a two-factor authentication reminder'
      )
  },
  'mfa.member.reset': {
    plain: (t) =>
      t(
        'settings.enterprise.audit.action.mfaMemberReset',
        'Reset a member’s two-factor authentication'
      )
  },
  'routine.create': {
    plain: (t) => t('settings.enterprise.audit.action.routineCreate', 'Created a routine')
  },
  'routine.update': {
    plain: (t) => t('settings.enterprise.audit.action.routineUpdate', 'Edited a routine')
  },
  'routine.delete': {
    plain: (t) => t('settings.enterprise.audit.action.routineDelete', 'Deleted a routine')
  },
  'routine.disable': {
    plain: (t) => t('settings.enterprise.audit.action.routineDisable', 'Turned off a routine')
  },
  'routine.run': {
    plain: (t) => t('settings.enterprise.audit.action.routineRun', 'Ran a routine')
  },
  'routine.run.start': {
    plain: (t) => t('settings.enterprise.audit.action.routineRunStart', 'A routine run started')
  },
  'routine.run.finish': {
    plain: (t) => t('settings.enterprise.audit.action.routineRunFinish', 'A routine run finished')
  },
  'routine.rotate_webhook': {
    plain: (t) =>
      t('settings.enterprise.audit.action.routineWebhook', 'Replaced a routine’s webhook URL')
  },
  ...WORKSPACE_AUDIT_ACTIONS
}

/** The name to put in the sentence: what the control plane labelled the target, else a recorded name. */
/** A teammate the row is about whom the control plane could not name (see unnamedPersonIn). */
function unnamedMemberTarget(event: CloudAuditEvent): string | null {
  const target = event.target
  return target?.type === 'member' && target.id && !target.label?.trim() ? target.id : null
}

function targetName(
  event: CloudAuditEvent,
  nameOf: (userId: string) => string | null
): string | null {
  const recorded = event.detail?.name
  const member = unnamedMemberTarget(event)
  const name =
    event.target?.label ??
    (typeof recorded === 'string' ? recorded : null) ??
    (member ? nameOf(member) : null)
  const clean = name?.trim()
  return clean ? clean.slice(0, 80) : null
}

/** "Created API key “CI deploy”"; an unknown action reads as its machine name. */
export function auditEventSentence(
  event: CloudAuditEvent,
  t: Translate = translate,
  locale?: string,
  /** Names a teammate by id from the team roster; the control plane only knows people who have used Orca Cloud. */
  nameOf: (userId: string) => string | null = () => null
): string {
  const copy = ACTIONS[event.action]
  if (!copy) {
    return event.action
  }
  const name = targetName(event, nameOf)
  const detailed = event.detail
    ? copy.detailed?.(t, event.detail, locale, { name, actorUserId: event.actor.userId, nameOf })
    : null
  if (detailed) {
    return detailed
  }
  return name && copy.named ? copy.named(t, name) : copy.plain(t)
}

/** Whether this version words the action (the rest show their machine name). */
export function isKnownAuditAction(action: string): boolean {
  return action in ACTIONS
}

/**
 * The teammate a row names in its sentence whom the control plane could not name (it only knows
 * people who have used Orca Cloud in this team), so the roster is read only when a row needs it.
 */
export function unnamedPersonIn(event: CloudAuditEvent): string | null {
  if (event.action !== 'workspace.owner_changed' && event.action !== 'workspace.owner_notified') {
    // A role change or removal whose member the control plane could not name.
    return unnamedMemberTarget(event)
  }
  const owner = event.detail?.toUserId
  const named = typeof event.detail?.toUserName === 'string' && event.detail.toUserName.trim()
  return typeof owner === 'string' && !named && owner !== event.actor.userId ? owner : null
}
