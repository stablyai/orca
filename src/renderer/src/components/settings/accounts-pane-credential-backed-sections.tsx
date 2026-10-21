import { GrokAccountsSection } from './GrokAccountsSection'
import { CursorAccountsSection } from './CursorAccountsSection'
import { ZcodePlanAccountsSection } from './ZcodePlanAccountsSection'
import { CommandCodeAccountsSection } from './CommandCodeAccountsSection'
import { matchesSettingsSearch } from './settings-search'
import {
  getAccountsCursorSearchEntries,
  getAccountsGrokSearchEntries,
  getAccountsZcodePlanSearchEntries
} from './accounts-search'
import { getAccountsCommandCodeSearchEntries } from './accounts-command-code-search'
import type { UsageCredentialHost } from './usage-credential-host'
import type { UsageHostSettingsModel } from './use-usage-host-settings'

/**
 * Sections whose credential lives in the provider's own CLI or desktop files
 * rather than in Orca settings. Grouped here so each entry stays one line in
 * AccountsPane and a new provider cannot drift out of the settings search.
 */
export function renderCredentialBackedAccountsSections(
  searchQuery: string,
  host: UsageCredentialHost,
  usageSettings: UsageHostSettingsModel,
  accountOwnerKey: string
): (React.JSX.Element | null)[] {
  return [
    matchesSettingsSearch(searchQuery, getAccountsGrokSearchEntries()) ? (
      <GrokAccountsSection key="grok" />
    ) : null,
    matchesSettingsSearch(searchQuery, getAccountsCursorSearchEntries()) ? (
      <CursorAccountsSection key="cursor" />
    ) : null,
    matchesSettingsSearch(searchQuery, getAccountsZcodePlanSearchEntries()) ? (
      <ZcodePlanAccountsSection
        key={`zcode:${accountOwnerKey}`}
        host={host}
        usageSettings={usageSettings}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getAccountsCommandCodeSearchEntries()) ? (
      <CommandCodeAccountsSection key="command-code" />
    ) : null
  ]
}
