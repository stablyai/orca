import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export const CREDENTIAL_VAULT_SECTION = 'credential-vault'

export function getCredentialVaultSearchEntry(t: Translate = translate) {
  return {
    title: t('settings.credentialVault.title', 'Vault'),
    description: t(
      'settings.credentialVault.description',
      'Save passwords, API keys, and tokens on this computer or on a paired Orca server. Each host has a separate vault.'
    ),
    keywords: [
      t('settings.credentialVault.searchPasswords', 'passwords'),
      t('settings.credentialVault.searchKeys', 'API keys'),
      t('settings.credentialVault.searchCredentials', 'credentials'),
      t('settings.credentialVault.searchSecrets', 'secrets')
    ]
  }
}
