import React from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import type { WebhookServerEndpoint } from '../../../../shared/automations-types'
import { getDefaultWebhookServerSettings } from '../../../../shared/constants'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

type WebhookServerSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function WebhookServerSetting({
  settings,
  updateSettings
}: WebhookServerSettingProps): React.JSX.Element {
  const current = settings.webhookServer ?? getDefaultWebhookServerSettings()
  const [endpoint, setEndpoint] = React.useState<WebhookServerEndpoint | null>(null)

  // Why: surface the live listener state (bound host/port or a bind error like
  // a port already in use) so the toggle gives real feedback, not just intent.
  React.useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void window.api.automations
        .getWebhookEndpoint()
        .then((next) => {
          if (!cancelled) {
            setEndpoint(next)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setEndpoint(null)
          }
        })
    }
    load()
    return () => {
      cancelled = true
    }
  }, [current.enabled, current.bindAddress, current.port])

  const title = 'Webhooks'
  const description = 'Receive inbound webhooks that trigger automations.'

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader title={title} description={description} />
      <SearchableSetting
        title={title}
        description={description}
        keywords={['webhook', 'automation', 'trigger', 'http', 'receiver']}
        className="space-y-3 py-2"
        id="advanced-webhook-server"
      >
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.WebhookServerSetting.fde97ffd63',
            'Enable webhook receiver'
          )}
          description={translate(
            'auto.components.settings.WebhookServerSetting.d799d4c875',
            'Let incoming webhooks trigger automations.'
          )}
          checked={current.enabled}
          onChange={() =>
            updateSettings({ webhookServer: { ...current, enabled: !current.enabled } })
          }
        />

        {current.enabled ? (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <div className="space-y-1">
              <Label htmlFor="webhook-bind-address">
                {translate(
                  'auto.components.settings.WebhookServerSetting.2c8ce1e9b1',
                  'Bind address'
                )}
              </Label>
              <Input
                id="webhook-bind-address"
                value={current.bindAddress}
                spellCheck={false}
                onChange={(event) =>
                  updateSettings({ webhookServer: { ...current, bindAddress: event.target.value } })
                }
              />
              <p className="text-[11px] text-muted-foreground">
                {translate(
                  'auto.components.settings.WebhookServerSetting.0471c7e071',
                  'Use 127.0.0.1 for local only, or a LAN IP / 0.0.0.0 to accept requests from other hosts.'
                )}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="webhook-port">
                {translate('auto.components.settings.WebhookServerSetting.029f99d666', 'Port')}
              </Label>
              <Input
                id="webhook-port"
                type="number"
                min={1}
                max={65535}
                value={String(current.port)}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10)
                  if (Number.isFinite(parsed)) {
                    updateSettings({ webhookServer: { ...current, port: parsed } })
                  }
                }}
              />
            </div>
          </div>
        ) : null}

        {current.enabled && endpoint ? (
          <p className="text-[11px] text-muted-foreground">
            {endpoint.error
              ? translate(
                  'auto.components.settings.WebhookServerSetting.56f3edce73',
                  'Listener error: {{value0}}',
                  { value0: endpoint.error }
                )
              : endpoint.running
                ? translate(
                    'auto.components.settings.WebhookServerSetting.657a5c0ffb',
                    'Listening on {{value0}}:{{value1}}.',
                    { value0: endpoint.bindAddress, value1: endpoint.port }
                  )
                : translate(
                    'auto.components.settings.WebhookServerSetting.fabf4be778',
                    'Listener is not running.'
                  )}
          </p>
        ) : null}
        {current.bindAddress === '0.0.0.0' ? (
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.settings.WebhookServerSetting.08a0db238d',
              '0.0.0.0 exposes the receiver to your whole network. Set a per-automation secret on each webhook trigger.'
            )}
          </p>
        ) : null}
      </SearchableSetting>
    </section>
  )
}
