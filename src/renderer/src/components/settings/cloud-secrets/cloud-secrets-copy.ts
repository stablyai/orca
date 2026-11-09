import type { Translate } from '@/i18n/use-translate'
import type {
  CloudSecretScope,
  CloudSecretsErrorCode
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import type { DotenvPasteIssue } from '../../../../../shared/cloud-secrets/dotenv-paste'

export function cloudSecretScopeLabel(scope: CloudSecretScope, t: Translate): string {
  switch (scope) {
    case 'personal':
      return t('cloudSecrets.scope.personal', 'Personal')
    case 'org':
      return t('cloudSecrets.scope.org', 'Shared')
    case 'repo':
      return t('cloudSecrets.scope.repo', 'Repo')
  }
}

/** Model and endpoint names are settings, not credentials, even though team values win for them too. */
export function cloudSecretKindLabel(name: string, t: Translate): string {
  return name.endsWith('_MODEL') ||
    name.endsWith('_BASE_URL') ||
    name.startsWith('CLAUDE_CODE_USE_')
    ? t('cloudSecrets.list.agentSetting', 'Agent setting')
    : t('cloudSecrets.list.agentKey', 'Agent key')
}

/** Friendly copy for a server reason or transport failure. Never quotes a value. */
export function cloudSecretsErrorCopy(
  code: CloudSecretsErrorCode | DotenvPasteIssue,
  t: Translate
): string {
  switch (code) {
    case 'invalid_name':
      return t(
        'cloudSecrets.error.invalidName',
        'Use capital letters, digits and underscores, not starting with a digit.'
      )
    case 'reserved_name':
      return t(
        'cloudSecrets.error.reservedName',
        'Orca manages this variable in cloud workspaces. Pick another name.'
      )
    case 'subscription_token_refused':
      return t(
        'cloudSecrets.error.subscriptionToken',
        'This is a Claude or ChatGPT subscription token, which can’t be stored. Sign the agent in instead.'
      )
    case 'value_too_large':
      return t('cloudSecrets.error.valueTooLarge', 'Values can be up to 8 KB.')
    case 'invalid_value':
      return t('cloudSecrets.error.invalidValue', 'Enter a value.')
    case 'repo_required':
      return t('cloudSecrets.error.repoRequired', 'Choose a repository first.')
    case 'invalid_base_url':
      return t(
        'cloudSecrets.error.invalidBaseUrl',
        'Base URLs must start with https:// and point at a public host.'
      )
    case 'org_admin_required':
      return t(
        'cloudSecrets.error.adminRequired',
        'Only team owners and admins can change this. Ask an admin.'
      )
    case 'no_org':
      return t('cloudSecrets.error.noOrg', 'Join or create a team to share secrets.')
    case 'secret_limit':
      return t(
        'cloudSecrets.error.limit',
        'This scope already holds 100 secrets. Delete one first.'
      )
    case 'unauthorized':
      return t('cloudSecrets.error.unauthorized', 'Sign in to Orca again to manage cloud secrets.')
    case 'not_configured':
      return t('cloudSecrets.error.notConfigured', 'Orca Cloud is not available in this build.')
    case 'unavailable':
    case 'timeout':
      return t('cloudSecrets.error.unavailable', 'Orca Cloud did not answer. Try again.')
    case 'syntax':
      return t('cloudSecrets.error.syntax', 'Not a NAME=value line.')
    case 'unterminated_quote':
      return t('cloudSecrets.error.unterminatedQuote', 'The closing quote is missing.')
    case 'overridden':
      return t('cloudSecrets.error.overridden', 'Set again further down; the later line is used.')
    case 'invalid_scope':
    case 'not_found':
    case 'unknown':
      return t('cloudSecrets.error.unknown', 'Orca Cloud could not do that. Try again.')
  }
}
