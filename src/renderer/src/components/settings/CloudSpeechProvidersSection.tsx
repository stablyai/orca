import {
  CLOUD_SPEECH_PROVIDERS,
  type CloudSpeechProviderId
} from '../../../../shared/cloud-speech-providers'
import { translate } from '@/i18n/i18n'
import { CloudSpeechProviderRow } from './CloudSpeechProviderRow'
import { SettingsBadge, SettingsSubsectionHeader } from './SettingsFormControls'
import type { CloudSpeechKeysController } from './voice-cloud-speech-keys'

type CloudSpeechProvidersSectionProps = {
  keys: CloudSpeechKeysController
  onConfigure: (providerId: CloudSpeechProviderId) => void
  onClear: (providerId: CloudSpeechProviderId) => void
}

export function CloudSpeechProvidersSection({
  keys,
  onConfigure,
  onClear
}: CloudSpeechProvidersSectionProps): React.JSX.Element {
  const connectedCount = CLOUD_SPEECH_PROVIDERS.filter(
    (provider) => keys.statusById[provider.id]?.configured
  ).length

  return (
    <section className="space-y-1 pt-4">
      <SettingsSubsectionHeader
        title={
          <span className="flex items-center gap-2">
            {translate(
              'auto.components.settings.CloudSpeechProvidersSection.title',
              'Cloud Providers'
            )}
            {connectedCount > 0 ? (
              <SettingsBadge tone="muted">
                {translate(
                  'auto.components.settings.CloudSpeechProvidersSection.connectedCount',
                  '{{connected}} connected',
                  { connected: connectedCount }
                )}
              </SettingsBadge>
            ) : null}
          </span>
        }
        description={translate(
          'auto.components.settings.CloudSpeechProvidersSection.description',
          'API keys for cloud speech models. Keys stay on this computer; paired phones use them through it.'
        )}
      />
      <div className="divide-y divide-border/40">
        {CLOUD_SPEECH_PROVIDERS.map((provider) => (
          <CloudSpeechProviderRow
            key={provider.id}
            provider={provider}
            status={keys.statusById[provider.id]}
            pending={keys.pendingById[provider.id] === true}
            test={keys.testById[provider.id]}
            onConfigure={() => onConfigure(provider.id)}
            onClear={() => onClear(provider.id)}
            onTest={() => void keys.testKey(provider.id)}
          />
        ))}
      </div>
    </section>
  )
}
