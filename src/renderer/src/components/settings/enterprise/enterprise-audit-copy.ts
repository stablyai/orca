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
  'workspace.create': {
    plain: (t) =>
      t('auto.components.settings.cloudApi.audit.action.wsCreate', 'Started a workspace'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.wsCreateNamed', 'Started workspace “{{name}}”', { name })
  },
  'workspace.destroy': {
    plain: (t) =>
      t('auto.components.settings.cloudApi.audit.action.wsDestroy', 'Deleted a workspace'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.wsDestroyNamed', 'Deleted workspace “{{name}}”', { name })
  },
  'workspace.sleep': {
    plain: (t) =>
      t('auto.components.settings.cloudApi.audit.action.wsSleep', 'Put a workspace to sleep'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.wsSleepNamed', 'Put workspace “{{name}}” to sleep', {
        name
      })
  },
  'workspace.wake': {
    plain: (t) => t('auto.components.settings.cloudApi.audit.action.wsWake', 'Woke a workspace'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.wsWakeNamed', 'Woke workspace “{{name}}”', { name })
  },
  'workspace.archive': {
    plain: (t) =>
      t('auto.components.settings.cloudApi.audit.action.wsArchive', 'Archived a workspace'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.wsArchiveNamed', 'Archived workspace “{{name}}”', {
        name
      })
  },
  'workspace.unarchive': {
    plain: (t) => t('settings.enterprise.audit.action.wsUnarchive', 'Restored a workspace'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.wsUnarchiveNamed', 'Restored workspace “{{name}}”', {
        name
      })
  },
  'workspace.rename': {
    plain: (t) => t('settings.enterprise.audit.action.wsRename', 'Renamed a workspace'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.wsRenameNamed', 'Renamed a workspace to “{{name}}”', {
        name
      })
  },
  'workspace.share_create': {
    plain: (t) =>
      t('settings.enterprise.audit.action.wsShare', 'Shared a link to a workspace port'),
    named: (t, name) =>
      t(
        'settings.enterprise.audit.action.wsShareNamed',
        'Shared a link to a port on workspace “{{name}}”',
        { name }
      )
  },
  'workspace.share_revoke': {
    plain: (t) =>
      t('settings.enterprise.audit.action.wsUnshare', 'Turned off a workspace share link'),
    named: (t, name) =>
      t(
        'settings.enterprise.audit.action.wsUnshareNamed',
        'Turned off a share link on workspace “{{name}}”',
        { name }
      )
  },
  'workspace.message': {
    plain: (t) => t('auto.components.settings.cloudApi.audit.action.wsMessage', 'Messaged an agent')
  },
  'workspace.attachment': {
    plain: (t) => t('settings.enterprise.audit.action.wsAttachment', 'Sent a file to an agent')
  },
  'workspace.session.create': {
    plain: (t) => t('settings.enterprise.audit.action.sessionCreate', 'Started an agent')
  },
  'workspace.session.cancel': {
    plain: (t) => t('settings.enterprise.audit.action.sessionCancel', 'Stopped an agent')
  },
  'workspace.session.rename': {
    plain: (t) => t('settings.enterprise.audit.action.sessionRename', 'Renamed an agent session')
  },
  'sandbox.ssh_key_added': {
    plain: (t) => t('settings.enterprise.audit.action.sshAdd', 'Added an SSH key to a workspace'),
    named: (t, name) =>
      t(
        'settings.enterprise.audit.action.sshAddNamed',
        'Added an SSH key to workspace “{{name}}”',
        {
          name
        }
      )
  },
  'sandbox.ssh_key_removed': {
    plain: (t) =>
      t('settings.enterprise.audit.action.sshRemove', 'Removed an SSH key from a workspace'),
    named: (t, name) =>
      t(
        'settings.enterprise.audit.action.sshRemoveNamed',
        'Removed an SSH key from workspace “{{name}}”',
        { name }
      )
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
  }
}

/** The name to put in the sentence: what the control plane labelled the target, else a recorded name. */
function targetName(event: CloudAuditEvent): string | null {
  const recorded = event.detail?.name
  const name = event.target?.label ?? (typeof recorded === 'string' ? recorded : null)
  const clean = name?.trim()
  return clean ? clean.slice(0, 80) : null
}

/** "Created API key “CI deploy”"; an unknown action reads as its machine name. */
export function auditEventSentence(
  event: CloudAuditEvent,
  t: Translate = translate,
  locale?: string
): string {
  const copy = ACTIONS[event.action]
  if (!copy) {
    return event.action
  }
  const detailed = event.detail ? copy.detailed?.(t, event.detail, locale) : null
  if (detailed) {
    return detailed
  }
  const name = targetName(event)
  return name && copy.named ? copy.named(t, name) : copy.plain(t)
}

/** Whether this version words the action (the rest show their machine name). */
export function isKnownAuditAction(action: string): boolean {
  return action in ACTIONS
}
