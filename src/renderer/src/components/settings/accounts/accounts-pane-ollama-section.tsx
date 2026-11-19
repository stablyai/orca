import type { ReactElement } from 'react'
import { matchesSettingsSearch } from '../search/settings-search'
import { OllamaCloudAccountsSection } from '../OllamaCloudAccountsSection'
import { getAccountsOllamaSearchEntries } from '../ollama-cloud-accounts-search'
import type { UsageCredentialHost } from './usage/usage-credential-host'

export function renderOllamaAccountsSection(
  searchQuery: string,
  accountOwnerKey: string,
  host: UsageCredentialHost
): ReactElement | null {
  return matchesSettingsSearch(searchQuery, getAccountsOllamaSearchEntries()) ? (
    <OllamaCloudAccountsSection key={`ollama:${accountOwnerKey}`} host={host} />
  ) : null
}
