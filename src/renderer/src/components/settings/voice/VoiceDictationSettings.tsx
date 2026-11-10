import type {
  SpeechModelManifest,
  SpeechModelState,
  VoiceSettings
} from '../../../../../shared/speech-types'
import {
  dictationShortcutMode,
  dictationShortcutModeSettings,
  type DictationShortcutMode
} from '../../../../../shared/dictation-shortcut-mode'
import { useAppStore } from '@/store'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useShortcutKeyDetails, useShortcutLabel } from '@/hooks/useShortcutLabel'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { Switch } from '../../ui/switch'
import { SettingsRow, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { isSpeechModelDownloading } from './voice-speech-model-rows'

type VoiceDictationSettingsProps = {
  voiceSettings: VoiceSettings
  /** False until main sends the catalog; the status waits so it never claims there is no model. */
  catalogLoaded: boolean
  selectedModel: SpeechModelManifest | undefined
  selectedState: SpeechModelState | undefined
  permissionPending: boolean
  onToggleVoiceDictation: () => void
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

/** What the Dictation switch row says: what to do next, or how to dictate. */
function dictationStatus(
  { voiceSettings, selectedModel, selectedState }: VoiceDictationSettingsProps,
  shortcut: string,
  t: Translate
): string {
  const model = selectedModel?.label ?? ''
  if (selectedModel && selectedState?.needsUpdate) {
    return t(
      'components.settings.voice.dictation.needsUpdate',
      'Update {{model}} below to keep dictating.',
      {
        model
      }
    )
  }
  if (isSpeechModelDownloading(selectedState)) {
    return t(
      'components.settings.voice.dictation.downloading',
      'Works once {{model}} finishes downloading.',
      { model }
    )
  }
  if (!selectedModel || selectedState?.status !== 'ready') {
    return t(
      'components.settings.voice.dictation.noModel',
      'Download a speech model below to start. It runs on this computer, so your audio stays here.'
    )
  }
  return voiceSettings.enabled
    ? t('components.settings.voice.dictation.ready', 'Press {{shortcut}} in any pane.', {
        shortcut
      })
    : t(
        'components.settings.voice.dictation.off',
        'Turn on to dictate with {{shortcut}} in any pane.',
        {
          shortcut
        }
      )
}

export function VoiceDictationSettings(props: VoiceDictationSettingsProps): React.JSX.Element {
  const { voiceSettings, permissionPending, onToggleVoiceDictation, onUpdateVoiceSettings } = props
  const t = useTranslate()
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const shortcut = useShortcutLabel('voice.dictation')
  const shortcutKeys = useShortcutKeyDetails('voice.dictation')
  const mode = dictationShortcutMode(voiceSettings)
  const dictationLabel = t('components.settings.voice.dictation.label', 'Dictation')
  const modeLabel = t('components.settings.voice.mode.label', 'Mode')
  const modeDescription = {
    auto: t(
      'components.settings.voice.mode.auto',
      'Tap {{shortcut}} to start and stop, or hold it while you talk.',
      { shortcut }
    ),
    hold: t('components.settings.voice.mode.hold', 'Talk while you hold {{shortcut}}.', {
      shortcut
    }),
    toggle: t(
      'components.settings.voice.mode.toggle',
      'Press {{shortcut}} to start, and again to stop.',
      { shortcut }
    )
  }[mode]

  return (
    <SettingsGroup>
      <SettingsRow
        label={dictationLabel}
        description={props.catalogLoaded ? dictationStatus(props, shortcut, t) : undefined}
        control={
          <Switch
            checked={voiceSettings.enabled}
            aria-label={dictationLabel}
            aria-busy={permissionPending}
            disabled={permissionPending}
            onCheckedChange={onToggleVoiceDictation}
            className="disabled:cursor-wait disabled:opacity-70"
          />
        }
      />
      <SettingsRow
        label={t('components.settings.voice.input.shortcut', 'Shortcut')}
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
        label={modeLabel}
        description={modeDescription}
        control={
          <SettingsSegmentedControl<DictationShortcutMode>
            size="sm"
            value={mode}
            onChange={(next) => onUpdateVoiceSettings(dictationShortcutModeSettings(next))}
            ariaLabel={t('auto.components.settings.VoicePane.ba4a900d1d', 'Dictation Mode')}
            options={[
              {
                value: 'auto',
                label: t('auto.components.settings.VoicePane.dictationModeAuto', 'Auto')
              },
              { value: 'hold', label: t('auto.components.settings.VoicePane.174da92062', 'Hold') },
              {
                value: 'toggle',
                label: t('auto.components.settings.VoicePane.118b3c2dee', 'Toggle')
              }
            ]}
          />
        }
      />
    </SettingsGroup>
  )
}
