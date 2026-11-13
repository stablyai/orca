// Wording for the single sign-on and directory sync events the auth service sends. `named` takes
// what the event is about: the identity provider's name, or the email domain.
import type { ActionCopy } from './enterprise-audit-account-copy'

export const SSO_AUDIT_ACTIONS: Record<string, ActionCopy> = {
  'sso.setup_link_created': {
    plain: (t) =>
      t('settings.enterprise.audit.action.ssoSetupLink', 'Created a single sign-on setup link')
  },
  'sso.configured': {
    plain: (t) => t('settings.enterprise.audit.action.ssoConfigured', 'Set up single sign-on'),
    named: (t, name) =>
      t(
        'settings.enterprise.audit.action.ssoConfiguredNamed',
        'Set up single sign-on with {{name}}',
        {
          name
        }
      )
  },
  'sso.went_live': {
    plain: (t) => t('settings.enterprise.audit.action.ssoWentLive', 'Turned on single sign-on'),
    named: (t, name) =>
      t(
        'settings.enterprise.audit.action.ssoWentLiveNamed',
        'Turned on single sign-on with {{name}}',
        { name }
      )
  },
  'sso.removed': {
    plain: (t) => t('settings.enterprise.audit.action.ssoRemoved', 'Removed single sign-on')
  },
  'sso.sign_in_refused': {
    plain: (t) =>
      t(
        'settings.enterprise.audit.action.ssoSignInRefused',
        'Tried to sign in without single sign-on'
      )
  },
  'sso.sessions_ended': {
    plain: (t) =>
      t(
        'settings.enterprise.audit.action.ssoSessionsEnded',
        'Ended sign-ins made before single sign-on was turned on'
      )
  },
  'sso.domain_added': {
    plain: (t) => t('settings.enterprise.audit.action.ssoDomainAdded', 'Added an email domain'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.ssoDomainAddedNamed', 'Added email domain {{name}}', {
        name
      })
  },
  'sso.domain_verified': {
    plain: (t) =>
      t('settings.enterprise.audit.action.ssoDomainVerified', 'Verified an email domain'),
    named: (t, name) =>
      t(
        'settings.enterprise.audit.action.ssoDomainVerifiedNamed',
        'Verified email domain {{name}}',
        { name }
      )
  },
  'sso.domain_removed': {
    plain: (t) => t('settings.enterprise.audit.action.ssoDomainRemoved', 'Removed an email domain'),
    named: (t, name) =>
      t('settings.enterprise.audit.action.ssoDomainRemovedNamed', 'Removed email domain {{name}}', {
        name
      })
  },
  'sso.domain_record_missing': {
    plain: (t) =>
      t(
        'settings.enterprise.audit.action.ssoDomainRecordMissing',
        'Found an email domain’s DNS record missing'
      ),
    named: (t, name) =>
      t(
        'settings.enterprise.audit.action.ssoDomainRecordMissingNamed',
        'Found the DNS record for {{name}} missing',
        { name }
      )
  },
  'scim.enabled': {
    plain: (t) => t('settings.enterprise.audit.action.scimEnabled', 'Turned on directory sync')
  },
  'scim.disabled': {
    plain: (t) => t('settings.enterprise.audit.action.scimDisabled', 'Turned off directory sync')
  },
  'scim.key_created': {
    plain: (t) =>
      t('settings.enterprise.audit.action.scimKeyCreated', 'Created a directory sync key')
  },
  'scim.key_revoked': {
    plain: (t) =>
      t('settings.enterprise.audit.action.scimKeyRevoked', 'Revoked a directory sync key')
  },
  'scim.group_changed': {
    plain: (t) =>
      t('settings.enterprise.audit.action.scimGroupChanged', 'Changed a directory group')
  },
  'scim.group_membership_changed': {
    plain: (t) =>
      t(
        'settings.enterprise.audit.action.scimGroupMembershipChanged',
        'Changed who is in a directory group'
      )
  }
}
