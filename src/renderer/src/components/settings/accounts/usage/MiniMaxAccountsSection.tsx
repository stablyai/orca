import { ExternalLink, ShieldCheck } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { FeatureInteractionId } from '../../../../../../shared/feature-interaction-catalog'
import type { ProviderRateLimits } from '../../../../../../shared/rate-limit-types'
import { Label } from '../../../ui/label'
import { MiniMaxIcon } from '../../../status-bar/icons'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { DebouncedSettingsTextInput } from '../../form-controls/DebouncedSettingsTextInput'
import { MiniMaxCredentials, miniMaxStorageHelp } from './accounts-pane-minimax-credentials'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { useMiniMaxCredentials } from './use-minimax-credentials'
import {
  usageCredentialAccessNotice,
  usageCredentialStoredLabel,
  type UsageCredentialHost
} from './usage-credential-host'
import type { UsageHostSettingsModel } from './use-usage-host-settings'
import { SettingsGroup } from '../../section-layout/SettingsGroup'

export function MiniMaxAccountsSection({
  host,
  usageSettings,
  miniMaxRateLimits,
  recordFeatureInteraction
}: {
  host: UsageCredentialHost
  usageSettings: UsageHostSettingsModel
  /** This computer's poll; null for another host, whose usage it does not describe. */
  miniMaxRateLimits: ProviderRateLimits | null
  recordFeatureInteraction: (featureId: FeatureInteractionId) => void
}): React.JSX.Element {
  const t = useTranslate()
  const credentials = useMiniMaxCredentials(host.owner)
  const { miniMaxConfigured, miniMaxApiKeyConfigured, miniMaxCredentialBusy } = credentials
  const settings = usageSettings.settings
  const consoleUrl =
    settings?.minimaxEndpoint === 'cn'
      ? 'https://platform.minimaxi.com/console/usage'
      : 'https://platform.minimax.io/console/usage'
  const configured = miniMaxConfigured || miniMaxApiKeyConfigured
  const accessNotice = usageCredentialAccessNotice(host, credentials.access, t)
  const settingsUnavailable = settings === null
  const handleMiniMaxEndpointChange = (value: string): void => {
    if ((value !== 'overseas' && value !== 'cn') || value === settings?.minimaxEndpoint) {
      return
    }
    recordFeatureInteraction('usage-tracking')
    void usageSettings.update({ minimaxEndpoint: value })
  }
  return (
    <div id="accounts-minimax" className="scroll-mt-6">
      <SettingsGroup
        title={
          <span className="flex items-center gap-2">
            <MiniMaxIcon size={16} />
            {t('auto.components.settings.AccountsPane.5d63bbfbec', 'MiniMax')}
          </span>
        }
        description={t(
          'auto.components.settings.AccountsPane.usageTracking',
          'Configure MiniMax usage tracking for your account.'
        )}
        action={
          <a
            href={consoleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {t('auto.components.settings.AccountsPane.0d8e77bc40', 'Open console')}
            <ExternalLink className="size-3" />
          </a>
        }
      >
        <div className="flex items-start gap-3 py-3">
          <ShieldCheck
            className={cn(
              'mt-0.5 size-4 shrink-0',
              configured ? 'text-foreground' : 'text-muted-foreground'
            )}
          />
          <div className="space-y-0.5">
            {accessNotice ? (
              <p className="text-xs font-medium">{accessNotice}</p>
            ) : (
              <p className="text-xs font-medium">
                {configured
                  ? usageCredentialStoredLabel(host, t)
                  : t(
                      'auto.components.settings.AccountsPane.credentialsNotSet',
                      'Credentials not set'
                    )}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{miniMaxStorageHelp(host, t)}</p>
          </div>
        </div>

        <SearchableSetting
          title={t('auto.components.settings.AccountsPane.f8a4b9d210', 'MiniMax endpoint')}
          description={t(
            'auto.components.settings.AccountsPane.0b3a9f6c2e',
            'Pick the host that matches your account. Both overseas (platform.minimax.io) and China (platform.minimaxi.com) accept either a session cookie or an API key.'
          )}
          keywords={['minimax', 'endpoint', 'region', 'host', 'cn', 'china', 'overseas', 'api key']}
          className="space-y-2 py-3"
        >
          <Label htmlFor="minimax-endpoint">
            {t('auto.components.settings.AccountsPane.f8a4b9d210', 'MiniMax endpoint')}
          </Label>
          <Select
            value={settings?.minimaxEndpoint ?? ''}
            onValueChange={handleMiniMaxEndpointChange}
            disabled={miniMaxCredentialBusy || settingsUnavailable}
          >
            <SelectTrigger id="minimax-endpoint" className="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[
                {
                  value: 'overseas',
                  label: t(
                    'auto.components.settings.AccountsPane.endpointOverseas',
                    'Overseas (platform.minimax.io)'
                  )
                },
                {
                  value: 'cn',
                  label: t(
                    'auto.components.settings.AccountsPane.endpointChina',
                    'China (platform.minimaxi.com)'
                  )
                }
              ].map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SearchableSetting>

        <MiniMaxCredentials
          credentials={credentials}
          host={host}
          miniMaxRateLimits={miniMaxRateLimits}
          consoleUrl={consoleUrl}
        />

        <div>
          <div className="flex items-center justify-between gap-3 pt-4 pb-3">
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-muted-foreground">
                {t('auto.components.settings.AccountsPane.9dd50d3f75', 'Advanced')}
              </h4>
              <p className="text-xs text-muted-foreground">
                {t(
                  'auto.components.settings.AccountsPane.174fb408f9',
                  'Leave these defaults alone unless MiniMax usage refresh points at the wrong workspace or model.'
                )}
              </p>
            </div>
          </div>

          <SearchableSetting
            title={t('auto.components.settings.AccountsPane.bf160bb6c0', 'Group ID override')}
            description={t(
              'auto.components.settings.AccountsPane.b1e2743313',
              'Optional. Leave blank to use minimax_group_id_v2 from the cookie.'
            )}
            keywords={['minimax', 'group', 'id', 'rate limit']}
            className="space-y-2 py-3"
          >
            <Label>
              {t('auto.components.settings.AccountsPane.bf160bb6c0', 'Group ID override')}
            </Label>
            <DebouncedSettingsTextInput
              type="text"
              value={settings?.minimaxGroupId ?? ''}
              commit={(minimaxGroupId) => void usageSettings.update({ minimaxGroupId })}
              disabled={settingsUnavailable}
              placeholder={t(
                'auto.components.settings.AccountsPane.0747d6391a',
                'Use group ID from cookie'
              )}
              spellCheck={false}
              className="text-xs"
            />
          </SearchableSetting>

          <SearchableSetting
            title={t('auto.components.settings.AccountsPane.4ff2af7524', 'Usage model names')}
            description={t(
              'auto.components.settings.AccountsPane.5cf4b0f85f',
              'Optional comma-separated model names. Leave as general unless MiniMax returns a model-specific error.'
            )}
            keywords={['minimax', 'model', 'general', 'rate limit']}
            className="space-y-2 py-3"
          >
            <Label>
              {t('auto.components.settings.AccountsPane.4ff2af7524', 'Usage model names')}
            </Label>
            <DebouncedSettingsTextInput
              type="text"
              value={settings?.minimaxUsageModels ?? ''}
              commit={(minimaxUsageModels) => void usageSettings.update({ minimaxUsageModels })}
              disabled={settingsUnavailable}
              placeholder={t('auto.components.settings.AccountsPane.3c92b0d31c', 'general')}
              spellCheck={false}
              className="text-xs"
            />
          </SearchableSetting>
        </div>
      </SettingsGroup>
    </div>
  )
}
