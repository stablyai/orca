import { ExternalLink, ShieldCheck } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Label } from '../ui/label'
import { MiniMaxIcon } from '../status-bar/icons'
import { SearchableSetting } from './SearchableSetting'
import type { AccountsPaneSectionModel } from './accounts-pane-types'
import { DebouncedSettingsTextInput } from './DebouncedSettingsTextInput'

import { MiniMaxCredentials } from './accounts-pane-minimax-credentials'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

export function renderMiniMaxAccountsSection(model: AccountsPaneSectionModel): React.JSX.Element {
  const {
    miniMaxConfigured,
    miniMaxApiKeyConfigured,
    miniMaxCredentialBusy,
    settings,
    updateSettings,
    recordFeatureInteraction
  } = model
  const consoleUrl =
    settings.minimaxEndpoint === 'cn'
      ? 'https://platform.minimaxi.com/console/usage'
      : 'https://platform.minimax.io/console/usage'
  const configured = miniMaxConfigured || miniMaxApiKeyConfigured
  const handleMiniMaxEndpointChange = (value: string): void => {
    if ((value !== 'overseas' && value !== 'cn') || value === settings.minimaxEndpoint) {
      return
    }
    recordFeatureInteraction('usage-tracking')
    void updateSettings({ minimaxEndpoint: value })
  }
  return (
    <section key="minimax" id="accounts-minimax" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <MiniMaxIcon size={16} />
            {translate('auto.components.settings.AccountsPane.5d63bbfbec', 'MiniMax')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.AccountsPane.usageTracking',
              'Configure MiniMax usage tracking for your account.'
            )}
          </p>
        </div>
        <a
          href={consoleUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate('auto.components.settings.AccountsPane.0d8e77bc40', 'Open console')}
          <ExternalLink className="size-3" />
        </a>
      </div>

      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
          configured ? 'border-border/60' : 'border-border/40'
        )}
      >
        <ShieldCheck
          className={cn(
            'mt-0.5 size-4 shrink-0',
            configured ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
        <div className="space-y-0.5">
          <p className="text-xs font-medium">
            {configured
              ? translate('auto.components.settings.AccountsPane.0b8c1c7e02', 'Stored locally')
              : translate(
                  'auto.components.settings.AccountsPane.credentialsNotSet',
                  'Credentials not set'
                )}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.AccountsPane.selectedEndpointStorage',
              'Stored locally and sent to the selected MiniMax endpoint for usage refreshes.'
            )}
          </p>
        </div>
      </div>

      <SearchableSetting
        title={translate('auto.components.settings.AccountsPane.f8a4b9d210', 'MiniMax endpoint')}
        description={translate(
          'auto.components.settings.AccountsPane.0b3a9f6c2e',
          'Pick the host that matches your account. Both overseas (platform.minimax.io) and China (platform.minimaxi.com) accept either a session cookie or an API key.'
        )}
        keywords={['minimax', 'endpoint', 'region', 'host', 'cn', 'china', 'overseas', 'api key']}
        className="space-y-2"
      >
        <Label htmlFor="minimax-endpoint">
          {translate('auto.components.settings.AccountsPane.f8a4b9d210', 'MiniMax endpoint')}
        </Label>
        <Select
          value={settings.minimaxEndpoint}
          onValueChange={handleMiniMaxEndpointChange}
          disabled={miniMaxCredentialBusy}
        >
          <SelectTrigger id="minimax-endpoint" className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[
              {
                value: 'overseas',
                label: translate(
                  'auto.components.settings.AccountsPane.endpointOverseas',
                  'Overseas (platform.minimax.io)'
                )
              },
              {
                value: 'cn',
                label: translate(
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

      <MiniMaxCredentials model={model} consoleUrl={consoleUrl} />

      <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <h4 className="text-xs font-semibold text-muted-foreground">
              {translate('auto.components.settings.AccountsPane.9dd50d3f75', 'Advanced')}
            </h4>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.AccountsPane.174fb408f9',
                'Leave these defaults alone unless MiniMax usage refresh points at the wrong workspace or model.'
              )}
            </p>
          </div>
        </div>

        <SearchableSetting
          title={translate('auto.components.settings.AccountsPane.bf160bb6c0', 'Group ID override')}
          description={translate(
            'auto.components.settings.AccountsPane.b1e2743313',
            'Optional. Leave blank to use minimax_group_id_v2 from the cookie.'
          )}
          keywords={['minimax', 'group', 'id', 'rate limit']}
          className="space-y-2"
        >
          <Label>
            {translate('auto.components.settings.AccountsPane.bf160bb6c0', 'Group ID override')}
          </Label>
          <DebouncedSettingsTextInput
            type="text"
            value={settings.minimaxGroupId}
            commit={(minimaxGroupId) => updateSettings({ minimaxGroupId })}
            placeholder={translate(
              'auto.components.settings.AccountsPane.0747d6391a',
              'Use group ID from cookie'
            )}
            spellCheck={false}
            className="text-xs"
          />
        </SearchableSetting>

        <SearchableSetting
          title={translate('auto.components.settings.AccountsPane.4ff2af7524', 'Usage model names')}
          description={translate(
            'auto.components.settings.AccountsPane.5cf4b0f85f',
            'Optional comma-separated model names. Leave as general unless MiniMax returns a model-specific error.'
          )}
          keywords={['minimax', 'model', 'general', 'rate limit']}
          className="space-y-2"
        >
          <Label>
            {translate('auto.components.settings.AccountsPane.4ff2af7524', 'Usage model names')}
          </Label>
          <DebouncedSettingsTextInput
            type="text"
            value={settings.minimaxUsageModels}
            commit={(minimaxUsageModels) => updateSettings({ minimaxUsageModels })}
            placeholder={translate('auto.components.settings.AccountsPane.3c92b0d31c', 'general')}
            spellCheck={false}
            className="text-xs"
          />
        </SearchableSetting>
      </div>
    </section>
  )
}
