import type { VoiceSettings } from '../../../../../shared/speech-types'
import {
  dictationShortcutMode,
  dictationShortcutModeSettings,
  type DictationShortcutMode
} from '../../../../../shared/dictation-shortcut-mode'
import { useAppStore } from '@/store'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useShortcutKeyDetails, useShortcutLabel } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader
} from '../form-controls/SettingsFormControls'
import { VoiceMicrophoneSetting } from './VoiceMicrophoneSetting'

export const VOICE_MICROPHONE_ROW_ID = 'voice-microphone'

type VoiceInputSettingsProps = {
  voiceSettings: VoiceSettings
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

export function VoiceInputSettings({
  voiceSettings,
  onUpdateVoiceSettings
}: VoiceInputSettingsProps): React.JSX.Element {
  const t = useTranslate()
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const shortcutLabel = useShortcutLabel('voice.dictation')
  const shortcutKeys = useShortcutKeyDetails('voice.dictation')

  return (
    <div className="space-y-1">
      <SettingsSubsectionHeader title={t('components.settings.voice.input.title', 'Input')} />
      <div className="divide-y divide-border">
        <SettingsRow
          label={t('components.settings.voice.input.shortcut', 'Shortcut')}
          description={t(
            'components.settings.voice.input.shortcutDescription',
            'Starts dictation in the focused pane.'
          )}
          control={
            <div className="flex items-center gap-2">
              <ShortcutKeyCombo keys={shortcutKeys.keys} doubleTap={shortcutKeys.doubleTap} />
              <Button
                variant="ghost"
                size="xs"
                onClick={() => openSettingsTarget({ pane: 'shortcuts', repoId: null })}
              >
                {t('components.settings.voice.input.changeShortcut', 'Change')}
              </Button>
            </div>
          }
        />
        <SettingsRow
          label={t('auto.components.settings.VoicePane.ba4a900d1d', 'Dictation Mode')}
          description={t(
            'auto.components.settings.VoicePane.dictationModesWithAutoDescription',
            'Auto: hold {{shortcut}} to dictate until you let go, or tap it to start and stop. Hold: dictate while {{shortcut}} is held. Toggle: press {{shortcut}} once to start, again to stop.',
            { shortcut: shortcutLabel }
          )}
          control={
            <SettingsSegmentedControl<DictationShortcutMode>
              value={dictationShortcutMode(voiceSettings)}
              onChange={(mode) => onUpdateVoiceSettings(dictationShortcutModeSettings(mode))}
              ariaLabel={t('auto.components.settings.VoicePane.ba4a900d1d', 'Dictation Mode')}
              options={[
                {
                  value: 'auto',
                  label: t('auto.components.settings.VoicePane.dictationModeAuto', 'Auto')
                },
                {
                  value: 'hold',
                  label: t('auto.components.settings.VoicePane.174da92062', 'Hold')
                },
                {
                  value: 'toggle',
                  label: t('auto.components.settings.VoicePane.118b3c2dee', 'Toggle')
                }
              ]}
            />
          }
        />
        <div id={VOICE_MICROPHONE_ROW_ID} className="scroll-mt-8">
          <VoiceMicrophoneSetting
            voiceSettings={voiceSettings}
            onUpdateVoiceSettings={onUpdateVoiceSettings}
          />
        </div>
      </div>
    </div>
  )
}
