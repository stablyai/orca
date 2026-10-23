import { translate } from '@/i18n/i18n'
import { USAGE_REQUEST_PROVIDERS } from '../../../../shared/usage-request-policy'
import { getProviderDisplayName } from '../status-bar/usage-error-copy'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { SearchableSetting } from './SearchableSetting'
import { getAccountsUsageRequestSearchEntries } from './accounts-search'
import type { UsageHostSettingsModel } from './use-usage-host-settings'

export function UsageRequestsSection({
  usageSettings,
  hostLabel
}: {
  usageSettings: UsageHostSettingsModel
  hostLabel: string | null
}): React.JSX.Element {
  const policy = usageSettings.requestPolicy
  const access = policy?.access ?? 'checking'
  const notice =
    access === 'checking'
      ? translate('settings.usageRequests.checking', 'Checking host usage request settings…')
      : access === 'outdated'
        ? translate(
            'settings.usageRequests.outdated',
            'Update Orca on this host to control usage requests. The current policy is unknown.'
          )
        : access === 'unreachable'
          ? translate(
              'settings.usageRequests.unreachable',
              'Could not reach this host. Its usage request settings are unknown.'
            )
          : null
  return (
    <section id="accounts-usage-requests" className="space-y-4 scroll-mt-6">
      <SearchableSetting {...getAccountsUsageRequestSearchEntries()[0]}>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">
            {translate('settings.usageRequests.title', 'Usage requests')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {hostLabel === null
              ? translate(
                  'settings.usageRequests.localOwner',
                  'Applies to this computer, including its WSL usage checks.'
                )
              : translate(
                  'settings.usageRequests.remoteOwner',
                  'Applies to {{host}}, where usage checks run.',
                  { host: hostLabel }
                )}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.usageRequests.description',
              'Off stops Orca’s automatic and manual usage checks. Agents, sign-in, and live Claude statusLine data continue. Cached usage keeps its original timestamp. Meter visibility is separate, except for Antigravity.'
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.usageRequests.geminiConsent',
              'Gemini credential permission is separate; enabling usage checks does not grant OAuth consent.'
            )}
          </p>
          {notice ? (
            <p role="status" className="text-xs text-muted-foreground">
              {notice}
            </p>
          ) : null}
        </div>
      </SearchableSetting>
      {access === 'ready'
        ? USAGE_REQUEST_PROVIDERS.map((provider) => {
            const name = getProviderDisplayName(provider)
            const label =
              provider === 'antigravity'
                ? translate(
                    'settings.usageRequests.showAndCheck',
                    '{{provider}}: Show and check usage',
                    { provider: name }
                  )
                : translate('settings.usageRequests.check', '{{provider}}: Check usage', {
                    provider: name
                  })
            return (
              <SearchableSetting
                key={provider}
                title={label}
                keywords={[
                  'usage requests',
                  'polling',
                  'quota',
                  'rate limit',
                  'disable',
                  'off',
                  'fetch',
                  provider
                ]}
                className="flex items-center justify-between gap-4 py-2"
              >
                <Label htmlFor={`usage-requests-${provider}`}>{label}</Label>
                <Switch
                  id={`usage-requests-${provider}`}
                  aria-label={translate(
                    'settings.usageRequests.accessibleLabel',
                    '{{setting}} on {{host}}',
                    {
                      setting: label,
                      host:
                        hostLabel ?? translate('settings.usageRequests.localHost', 'this computer')
                    }
                  )}
                  checked={policy?.enabled?.[provider] ?? false}
                  disabled={access !== 'ready' || policy?.pending}
                  onCheckedChange={(checked) => {
                    void policy?.update(provider, checked)
                  }}
                />
              </SearchableSetting>
            )
          })
        : null}
    </section>
  )
}
