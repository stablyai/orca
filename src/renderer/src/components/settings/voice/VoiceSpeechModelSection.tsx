import { useState } from 'react'
import { toast } from 'sonner'
import type {
  SpeechModelManifest,
  SpeechModelState,
  VoiceSettings
} from '../../../../../shared/speech-types'
import { useTranslate, useIntlLocale } from '@/i18n/use-translate'
import { languageDisplayName } from '@/i18n/ui-intl-formatters'
import {
  SettingsSegmentedControl,
  SettingsSubsectionHeader
} from '../form-controls/SettingsFormControls'
import {
  speechModelTab,
  voiceSpeechModelRows,
  type VoiceSpeechModelTab
} from './voice-speech-model-rows'
import { VoiceSpeechModelRow } from './VoiceSpeechModelRow'
import { cancelSpeechModelDownload, startSpeechModelDownload } from './speech-model-download'

type VoiceSpeechModelSectionProps = {
  voiceSettings: VoiceSettings
  catalog: SpeechModelManifest[]
  modelStates: SpeechModelState[]
  /** The language quality is rated for. */
  ratingLanguage: string
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
  onOpenCloudSetup: (modelId: string) => void
  onRefreshModelStates: () => void
  /** Provider rows (API keys, base URL) shown under the cloud models. */
  cloudSettings: React.ReactNode
}

export function VoiceSpeechModelSection({
  voiceSettings,
  catalog,
  modelStates,
  ratingLanguage,
  onUpdateVoiceSettings,
  onOpenCloudSetup,
  onRefreshModelStates,
  cloudSettings
}: VoiceSpeechModelSectionProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const selectedModel = catalog.find((m) => m.id === voiceSettings.sttModel)
  const [chosenTab, setTab] = useState<VoiceSpeechModelTab | null>(null)
  const tab = chosenTab ?? (selectedModel ? speechModelTab(selectedModel) : 'local')
  const [pendingDeleteModelIds, setPendingDeleteModelIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const rows = voiceSpeechModelRows(catalog, modelStates, tab, ratingLanguage)

  const setDeletePending = (modelId: string, pending: boolean): void =>
    setPendingDeleteModelIds((prev) => {
      const next = new Set(prev)
      if (pending) {
        next.add(modelId)
      } else {
        next.delete(modelId)
      }
      return next
    })

  const deleteModel = (modelId: string): void => {
    if (pendingDeleteModelIds.has(modelId)) {
      return
    }
    setDeletePending(modelId, true)
    void window.api.speech
      .deleteModel(modelId)
      .then(onRefreshModelStates)
      .catch(() =>
        toast.error(t('auto.components.settings.VoicePane.68de13f72c', 'Failed to delete model.'))
      )
      .finally(() => setDeletePending(modelId, false))
  }

  return (
    <div className="space-y-3">
      <SettingsSubsectionHeader
        title={t('auto.components.settings.VoicePane.43fd4f454b', 'Speech Model')}
        description={t(
          'components.settings.voice.models.description',
          'Quality is rated for {{language}}. Hover a rating to see the test behind it.',
          { language: languageDisplayName(ratingLanguage, intlLocale) }
        )}
        action={
          <SettingsSegmentedControl
            size="sm"
            value={tab}
            onChange={setTab}
            ariaLabel={t('components.settings.voice.models.where', 'Where models run')}
            options={[
              {
                value: 'local',
                label: t('components.settings.voice.models.local', 'On this computer')
              },
              { value: 'cloud', label: t('components.settings.voice.models.cloud', 'Cloud') }
            ]}
          />
        }
      />
      {tab === 'cloud' ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'components.settings.voice.models.cloudDescription',
            'Cloud models send your audio to the provider. Models on this computer keep it here.'
          )}
        </p>
      ) : null}
      <div
        role="list"
        aria-label={t('auto.components.settings.VoicePane.43fd4f454b', 'Speech Model')}
        className="divide-y divide-border"
      >
        {rows.map((row) => (
          <div role="listitem" key={row.manifest.id} className="py-0.5">
            <VoiceSpeechModelRow
              row={row}
              active={voiceSettings.sttModel === row.manifest.id}
              deletePending={pendingDeleteModelIds.has(row.manifest.id)}
              onUse={(modelId) => onUpdateVoiceSettings({ sttModel: modelId })}
              onDownload={(modelId) => startSpeechModelDownload(modelId, onRefreshModelStates)}
              onCancelDownload={(modelId) =>
                cancelSpeechModelDownload(modelId, onRefreshModelStates)
              }
              onDelete={deleteModel}
              onSetUpCloud={onOpenCloudSetup}
            />
          </div>
        ))}
      </div>
      {tab === 'cloud' ? cloudSettings : null}
    </div>
  )
}
