import type { VoiceSettings } from '../../../../shared/speech-types'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'

// Why: whisper needs an ISO 639-1 code to skip auto-detection; 'auto' keeps
// model-side detection. Labels are native names, so they are not translated.
const DICTATION_LANGUAGES: { code: string; label: string }[] = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
  { code: 'zh', label: '中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'ar', label: 'العربية' }
]

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
  const shortcutLabel = useShortcutLabel('voice.dictation')

  return (
    <>
      <div className="flex items-center justify-between gap-4 py-2">
        <div className="space-y-0.5">
          <Label>
            {translate('auto.components.settings.VoicePane.0121960365', 'Enable Voice Dictation')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate('auto.components.settings.VoicePane.4465596675', 'Press')} {shortcutLabel}{' '}
            {translate(
              'auto.components.settings.VoicePane.366e1b4f36',
              'to dictate text into any focused pane.'
            )}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={voiceSettings.enabled}
          aria-label={translate(
            'auto.components.settings.VoicePane.0121960365',
            'Enable Voice Dictation'
          )}
          aria-busy={permissionPending}
          disabled={permissionPending}
          onClick={() => void onToggleVoiceDictation()}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            voiceSettings.enabled ? 'bg-foreground' : 'bg-muted-foreground/30'
          } ${permissionPending ? 'cursor-wait opacity-70' : ''}`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              voiceSettings.enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <Separator />

      <div className="flex items-center justify-between gap-4 py-2">
        <div className="space-y-0.5">
          <Label>
            {translate('auto.components.settings.VoicePane.ba4a900d1d', 'Dictation Mode')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate('auto.components.settings.VoicePane.ff9a680010', 'Toggle: press')}{' '}
            {shortcutLabel}{' '}
            {translate(
              'auto.components.settings.VoicePane.295d84b849',
              'once to start, again to stop. Hold: dictate while'
            )}{' '}
            {shortcutLabel} {translate('auto.components.settings.VoicePane.7cf715f891', 'is held.')}
          </p>
        </div>
        <div className="flex shrink-0 items-center rounded-md border border-border/60 bg-background/50 p-0.5">
          {(['toggle', 'hold'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => onUpdateVoiceSettings({ dictationMode: mode })}
              disabled={!voiceSettings.enabled}
              className={`rounded-sm px-3 py-1 text-sm transition-colors ${
                voiceSettings.dictationMode === mode
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              } ${!voiceSettings.enabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {mode === 'toggle'
                ? translate('auto.components.settings.VoicePane.118b3c2dee', 'Toggle')
                : translate('auto.components.settings.VoicePane.174da92062', 'Hold')}
            </button>
          ))}
        </div>
      </div>

      <Separator />

      <div className="flex items-center justify-between gap-4 py-2">
        <div className="space-y-0.5">
          <Label>
            {translate('auto.components.settings.VoicePane.00ab56a6c0', 'Dictation Language')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.VoicePane.90c0cbd280',
              'Spoken language for transcription. Applies to Whisper and OpenAI models.'
            )}
          </p>
        </div>
        <Select
          value={voiceSettings.language || 'auto'}
          onValueChange={(value) => onUpdateVoiceSettings({ language: value })}
          disabled={!voiceSettings.enabled}
        >
          <SelectTrigger className="w-40 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DICTATION_LANGUAGES.map((lang) => (
              <SelectItem key={lang.code} value={lang.code}>
                {lang.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Separator />
    </>
  )
}
