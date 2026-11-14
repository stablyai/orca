import { useId } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '../../ui/button'
import type { VoiceSettings } from '../../../../../shared/speech-types'
import { useTranslate } from '@/i18n/use-translate'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'

// Radix Select cannot hold an empty value, and no Codex voice name has a colon.
const CODEX_DEFAULT_VALUE = 'codex:default'

function voiceLabel(voice: string): string {
  return `${voice.charAt(0).toUpperCase()}${voice.slice(1)}`
}

/** Codex's own conversational voice, apart from dictation's speech-to-text. */
export function VoiceCodexVoiceModeSettings({
  voiceSettings,
  voices,
  listing,
  onRefresh,
  onUpdateVoiceSettings
}: {
  voiceSettings: VoiceSettings
  /** What the most recent running Codex chat listed; null until one has. */
  voices: readonly string[] | null
  listing: boolean
  /** Asks the last Codex chat shown again; absent before any Codex chat was opened. */
  onRefresh?: () => void
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const labelId = useId()
  const chosen = voiceSettings.codexVoice
  // A choice from another Codex stays visible; the host falls back to the default if it is gone.
  const options = chosen && !voices?.includes(chosen) ? [chosen, ...(voices ?? [])] : (voices ?? [])
  const refreshLabel = t('components.settings.voice.codexVoiceMode.refresh', 'List voices again')

  return (
    <SettingsGroup
      bodyClassName="@container"
      title={t('components.settings.voice.codexVoiceMode.title', 'Codex Voice mode')}
      description={t(
        'components.settings.voice.codexVoiceMode.description',
        'Talk with Codex out loud in a chat. Separate from dictation.'
      )}
    >
      <SettingsRow
        label={t('components.settings.voice.codexVoiceMode.serviceLabel', 'Service')}
        description={t(
          'components.settings.voice.codexVoiceMode.serviceDescription',
          "Codex's native OpenAI voice, using your Codex sign-in."
        )}
        control={
          <span className="text-xs text-muted-foreground">
            {t('components.settings.voice.codexVoiceMode.serviceValue', 'Codex · OpenAI')}
          </span>
        }
      />
      <SettingsRow
        className="flex-col items-stretch @lg:flex-row @lg:items-center"
        label={t('components.settings.voice.codexVoiceMode.voiceLabel', 'Voice')}
        labelId={labelId}
        description={
          voices
            ? t(
                'components.settings.voice.codexVoiceMode.voiceDescription',
                'From your latest Codex chat. Start Voice mode to hear it.'
              )
            : t(
                'components.settings.voice.codexVoiceMode.voicesUnlisted',
                'Send a message in a Codex chat, then list voices again.'
              )
        }
        control={
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={refreshLabel}
              title={refreshLabel}
              disabled={!onRefresh || listing}
              onClick={onRefresh}
            >
              <RefreshCw className={`size-3.5 ${listing ? 'motion-safe:animate-spin' : ''}`} />
            </Button>
            <Select
              value={chosen ?? CODEX_DEFAULT_VALUE}
              onValueChange={(value) =>
                onUpdateVoiceSettings({
                  codexVoice: value === CODEX_DEFAULT_VALUE ? undefined : value
                })
              }
            >
              <SelectTrigger size="sm" className="min-w-32" aria-labelledby={labelId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CODEX_DEFAULT_VALUE}>
                  {t('components.settings.voice.codexVoiceMode.defaultVoice', 'Codex default')}
                </SelectItem>
                {options.map((voice) => (
                  <SelectItem key={voice} value={voice}>
                    {voiceLabel(voice)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />
    </SettingsGroup>
  )
}
