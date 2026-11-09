import type { VoiceSettings } from '../../../../../shared/speech-types'
import {
  dictationShortcutMode,
  dictationShortcutModeSettings
} from '../../../../../shared/dictation-shortcut-mode'
import { Label } from '../../ui/label'
import { Separator } from '../../ui/separator'
import { Switch } from '../../ui/switch'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { VoiceMicrophoneSetting } from './VoiceMicrophoneSetting'

type VoiceDictationSettingsSectionProps = {
  voiceSettings: VoiceSettings
  permissionPending: boolean
  onToggleVoiceDictation: () => void
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

export function VoiceDictationSettingsSection({
  voiceSettings,
  permissionPending,
  onToggleVoiceDictation,
  onUpdateVoiceSettings
}: VoiceDictationSettingsSectionProps): React.JSX.Element {
  const t = useTranslate()
  const shortcutLabel = useShortcutLabel('voice.dictation')
  const selectedMode = dictationShortcutMode(voiceSettings)
  const modeLabels = {
    auto: t('auto.components.settings.VoicePane.dictationModeAuto', 'Auto'),
    hold: t('auto.components.settings.VoicePane.174da92062', 'Hold'),
    toggle: t('auto.components.settings.VoicePane.118b3c2dee', 'Toggle')
  }

  return (
    <>
      <div className="flex items-center justify-between gap-4 py-2">
        <div className="space-y-0.5">
          <Label>
            {t('auto.components.settings.VoicePane.0121960365', 'Enable Voice Dictation')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.VoicePane.dictationShortcutDescription',
              'Press {{shortcut}} to dictate text into any focused pane.',
              { shortcut: shortcutLabel }
            )}
          </p>
        </div>
        <Switch
          checked={voiceSettings.enabled}
          aria-label={t('auto.components.settings.VoicePane.0121960365', 'Enable Voice Dictation')}
          aria-busy={permissionPending}
          disabled={permissionPending}
          onCheckedChange={() => void onToggleVoiceDictation()}
          className="disabled:cursor-wait disabled:opacity-70"
        />
      </div>

      <Separator />

      <div className="flex items-center justify-between gap-4 py-2">
        <div className="space-y-0.5">
          <Label>{t('auto.components.settings.VoicePane.ba4a900d1d', 'Dictation Mode')}</Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.VoicePane.dictationModesWithAutoDescription',
              'Auto: hold {{shortcut}} to dictate until you let go, or tap it to start and stop. Hold: dictate while {{shortcut}} is held. Toggle: press {{shortcut}} once to start, again to stop.',
              { shortcut: shortcutLabel }
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center rounded-md border border-border/60 bg-background/50 p-0.5">
          {(['auto', 'hold', 'toggle'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => onUpdateVoiceSettings(dictationShortcutModeSettings(mode))}
              disabled={!voiceSettings.enabled}
              className={`rounded-sm px-3 py-1 text-sm transition-colors ${
                selectedMode === mode
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              } ${!voiceSettings.enabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {modeLabels[mode]}
            </button>
          ))}
        </div>
      </div>

      <Separator />

      <VoiceMicrophoneSetting
        voiceSettings={voiceSettings}
        onUpdateVoiceSettings={onUpdateVoiceSettings}
      />

      <Separator />
    </>
  )
}
