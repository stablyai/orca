import type { VoiceSettings } from '../../../../../shared/speech-types'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { VoiceVocabularySetting } from './VoiceVocabularySetting'

type VoiceWordsSettingsProps = {
  voiceSettings: VoiceSettings
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

/** What dictation does to the words it hears: filler removal and the spelling dictionary. */
export function VoiceWordsSettings({
  voiceSettings,
  onUpdateVoiceSettings
}: VoiceWordsSettingsProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsGroup title={t('components.settings.voice.words.title', 'Words')}>
      <SettingsSwitchRow
        label={t('components.settings.voice.fillerWords.0134406785', 'Remove filler words')}
        description={t('components.settings.voice.fillerWords.short', 'Drops “um” and “uh”.')}
        checked={voiceSettings.removeFillerWords}
        onChange={() =>
          onUpdateVoiceSettings({ removeFillerWords: !voiceSettings.removeFillerWords })
        }
      />
      <div data-settings-row="" className="py-3">
        <VoiceVocabularySetting
          voiceSettings={voiceSettings}
          onUpdateVoiceSettings={onUpdateVoiceSettings}
        />
      </div>
      <SettingsSwitchRow
        label={t(
          'components.settings.voice.vocabulary.repoNameHint',
          'Use the repo name as a hint'
        )}
        description={t(
          'components.settings.voice.vocabulary.repoNameHintDescription',
          "Helps recognize the repo's name."
        )}
        checked={voiceSettings.dictationRepoNameHint !== false}
        onChange={() =>
          onUpdateVoiceSettings({
            dictationRepoNameHint: voiceSettings.dictationRepoNameHint === false
          })
        }
      />
    </SettingsGroup>
  )
}
