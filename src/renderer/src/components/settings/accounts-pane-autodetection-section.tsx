import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { SettingsSwitchRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { getAccountsAutodetectionSearchEntries } from './account-autodetection-search'
import { getAccountsCursorSearchEntries, getAccountsGrokSearchEntries } from './accounts-search'
import { matchesSettingsSearch } from './settings-search'
import { GrokAccountsSection } from './GrokAccountsSection'
import { CursorAccountsSection } from './CursorAccountsSection'
import type { useAiAccountAutodetection } from './use-ai-account-autodetection'

export function renderAccountsAutodetectionSection(
  autodetection: ReturnType<typeof useAiAccountAutodetection>
): React.JSX.Element {
  return (
    <SearchableSetting key="autodetection" {...getAccountsAutodetectionSearchEntries()[0]}>
      <SettingsSwitchRow
        label={getAccountsAutodetectionSearchEntries()[0].title}
        description={
          autodetection.enabled === undefined
            ? translate(
                'accounts.autodetection.unsupported',
                'This server has not reported support for automatic account detection settings. Update the server to configure this option.'
              )
            : getAccountsAutodetectionSearchEntries()[0].description
        }
        checked={autodetection.enabled !== false}
        disabled={autodetection.busy || autodetection.enabled === undefined}
        onChange={() => {
          void autodetection
            .toggle()
            .catch(() =>
              toast.error(
                translate(
                  'accounts.autodetection.failed',
                  'Could not update automatic account detection.'
                )
              )
            )
        }}
      />
    </SearchableSetting>
  )
}

function renderDisabledAmbientSection(
  provider: string,
  ambientDisabled: boolean
): React.JSX.Element {
  return (
    <section key={provider} className="space-y-1">
      <h3 className="text-sm font-semibold">{provider}</h3>
      <p className="text-xs text-muted-foreground">
        {ambientDisabled
          ? translate(
              'accounts.autodetection.disabled',
              'Automatic account detection is disabled. Terminal CLI logins are unaffected.'
            )
          : translate(
              'accounts.autodetection.remoteIdentity',
              'Local CLI identity is not inspected in a remote account scope.'
            )}
      </p>
    </section>
  )
}

export function renderAmbientProviderAccountsSections(
  searchQuery: string,
  ambientDisabled: boolean,
  isRemoteAccountScope: boolean
): (React.JSX.Element | null)[] {
  return [
    matchesSettingsSearch(searchQuery, getAccountsGrokSearchEntries()) ? (
      ambientDisabled || isRemoteAccountScope ? (
        renderDisabledAmbientSection('Grok', ambientDisabled)
      ) : (
        <GrokAccountsSection key="grok" />
      )
    ) : null,
    matchesSettingsSearch(searchQuery, getAccountsCursorSearchEntries()) ? (
      ambientDisabled || isRemoteAccountScope ? (
        renderDisabledAmbientSection('Cursor', ambientDisabled)
      ) : (
        <CursorAccountsSection key="cursor" />
      )
    ) : null
  ]
}
