// Wording for workspace audit events: starting, sleeping and deleting a workspace, who it is
// shared with, share links, SSH keys and agent sessions. (See enterprise-audit-copy.)
import type { ActionCopy } from './enterprise-audit-account-copy'

export const WORKSPACE_AUDIT_ACTIONS: Record<string, ActionCopy> = {
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
  'workspace.shared_with_team': {
    plain: (t) =>
      t('settings.enterprise.audit.action.wsShareTeam', 'Shared a workspace with the team'),
    named: (t, name) =>
      t(
        'settings.enterprise.audit.action.wsShareTeamNamed',
        'Shared workspace “{{name}}” with the team',
        { name }
      )
  },
  'workspace.made_private': {
    plain: (t) => t('settings.enterprise.audit.action.wsMakePrivate', 'Made a workspace private'),
    named: (t, name) =>
      t(
        'settings.enterprise.audit.action.wsMakePrivateNamed',
        'Made workspace “{{name}}” private',
        {
          name
        }
      )
  },
  'workspace.owner_changed': {
    plain: (t) =>
      t('settings.enterprise.audit.action.wsOwnerChanged', 'Changed the owner of a workspace'),
    named: (t, name) =>
      t(
        'settings.enterprise.audit.action.wsOwnerChangedNamed',
        'Changed the owner of workspace “{{name}}”',
        { name }
      ),
    // Says who got it: themselves, a teammate by name, or someone who has since left. With no
    // name to give, the plain sentences above are used. The previous owner is left out.
    detailed: (t, detail, _locale, { name, actorUserId, nameOf }) => {
      const owner = typeof detail.toUserId === 'string' ? detail.toUserId : null
      if (owner && owner === actorUserId) {
        return name
          ? t(
              'settings.enterprise.audit.action.wsOwnerTookNamed',
              'Took ownership of workspace “{{name}}”',
              {
                name
              }
            )
          : t('settings.enterprise.audit.action.wsOwnerTook', 'Took ownership of a workspace')
      }
      if (detail.toUserFormer === true) {
        return name
          ? t(
              'settings.enterprise.audit.action.wsOwnerFormerNamed',
              'Made a former member the owner of workspace “{{name}}”',
              { name }
            )
          : t(
              'settings.enterprise.audit.action.wsOwnerFormer',
              'Made a former member the owner of a workspace'
            )
      }
      // The control plane names people who have used Orca Cloud in this team; a teammate who has
      // not is named from the team roster, like the person column.
      const person = (
        (typeof detail.toUserName === 'string' ? detail.toUserName : '') ||
        (owner ? nameOf(owner) : null) ||
        ''
      )
        .trim()
        .slice(0, 80)
      if (!person) {
        return null
      }
      return name
        ? t(
            'settings.enterprise.audit.action.wsOwnerMadeNamed',
            'Made {{person}} the owner of workspace “{{name}}”',
            { person, name }
          )
        : t(
            'settings.enterprise.audit.action.wsOwnerMade',
            'Made {{person}} the owner of a workspace',
            {
              person
            }
          )
    }
  },
  // Orca's own row after an owner change: whether anything reached the previous owner (a notice
  // waiting for them in Orca, or a delivered email), not whether they have read it.
  'workspace.owner_notified': {
    plain: (t) =>
      t(
        'settings.enterprise.audit.action.wsOwnerNotified',
        'Notified the previous owner about an owner change'
      ),
    detailed: (t, detail, _locale, { name, nameOf }) => {
      const previous = typeof detail.toUserId === 'string' ? detail.toUserId : null
      const person =
        (
          (typeof detail.toUserName === 'string' ? detail.toUserName : '') ||
          (previous && detail.toUserFormer !== true ? nameOf(previous) : null) ||
          ''
        )
          .trim()
          .slice(0, 80) ||
        (detail.toUserFormer === true
          ? t('settings.enterprise.audit.action.wsOwnerNotifiedFormer', 'a former member')
          : t('settings.enterprise.audit.action.wsOwnerNotifiedPrevious', 'the previous owner'))
      if (detail.reached === true) {
        return name
          ? t(
              'settings.enterprise.audit.action.wsOwnerNotifiedNamed',
              'Notified {{person}} about the owner change for workspace “{{name}}”',
              { person, name }
            )
          : t(
              'settings.enterprise.audit.action.wsOwnerNotifiedPlain',
              'Notified {{person}} about the owner change for a workspace',
              { person }
            )
      }
      return name
        ? t(
            'settings.enterprise.audit.action.wsOwnerNotNotifiedNamed',
            'Couldn’t notify {{person}} about the owner change for workspace “{{name}}”',
            { person, name }
          )
        : t(
            'settings.enterprise.audit.action.wsOwnerNotNotifiedPlain',
            'Couldn’t notify {{person}} about the owner change for a workspace',
            { person }
          )
    }
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
  }
}
