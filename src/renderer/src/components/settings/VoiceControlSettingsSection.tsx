import { useEffect, useState } from 'react'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import type { VoiceSettings } from '../../../../shared/speech-types'
import type {
  OpenAiRealtimeVoice,
  VoiceControlAgentVoiceMode,
  VoiceControlSettings
} from '../../../../shared/voice-control-types'
import { OPENAI_REALTIME_VOICES } from '../../../../shared/voice-control-types'
import { getDefaultVoiceControlSettings } from '../../../../shared/constants'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import { translate } from '@/i18n/i18n'

type VoiceControlSettingsSectionProps = {
  voiceSettings: VoiceSettings
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

const MAX_SESSION_MINUTE_OPTIONS = [0, 15, 30, 60, 120] as const

function formatCoordinatorVoiceName(voice: OpenAiRealtimeVoice): string {
  return voice.slice(0, 1).toUpperCase() + voice.slice(1)
}

function maxSessionMinutesLabel(minutes: number): string {
  switch (minutes) {
    case 15:
      return translate(
        'auto.components.settings.VoiceControlSettingsSection.f20cc19e9c',
        '15 minutes'
      )
    case 30:
      return translate(
        'auto.components.settings.VoiceControlSettingsSection.5cb51b7dd9',
        '30 minutes'
      )
    case 60:
      return translate('auto.components.settings.VoiceControlSettingsSection.e6e8c4b5cc', '1 hour')
    case 120:
      return translate('auto.components.settings.VoiceControlSettingsSection.38381e90a1', '2 hours')
    default:
      return translate(
        'auto.components.settings.VoiceControlSettingsSection.0e2029a54e',
        'Unlimited'
      )
  }
}

export function VoiceControlSettingsSection({
  voiceSettings,
  onUpdateVoiceSettings
}: VoiceControlSettingsSectionProps): React.JSX.Element {
  const control = voiceSettings.control ?? getDefaultVoiceControlSettings()
  const shortcutLabel = useShortcutLabel('voice.control')
  const [customInstructionsDraft, setCustomInstructionsDraft] = useState(control.customInstructions)
  useEffect(() => {
    setCustomInstructionsDraft(control.customInstructions)
  }, [control.customInstructions])

  const updateControl = (updates: Partial<VoiceControlSettings>): void => {
    onUpdateVoiceSettings({ control: { ...control, ...updates } })
  }

  return (
    <>
      <div className="flex items-center justify-between gap-4 py-2">
        <div className="space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.VoiceControlSettingsSection.929f8f1e88',
              'Enable Full Voice Control'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.VoiceControlSettingsSection.f6b7ed75c2',
              'Press {{shortcut}} to start or stop. Talk to your agents hands-free with an open mic.',
              { shortcut: shortcutLabel }
            )}
          </p>
        </div>
        <Switch
          checked={control.enabled}
          aria-label={translate(
            'auto.components.settings.VoiceControlSettingsSection.929f8f1e88',
            'Enable Full Voice Control'
          )}
          onCheckedChange={(enabled) => updateControl({ enabled })}
        />
      </div>

      <div className="flex items-center justify-between gap-4 py-2">
        <div className="min-w-0 space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.VoiceControlSettingsSection.bcc40a5cfc',
              'Coordinator voice'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.VoiceControlSettingsSection.ce44817e26',
              'The voice the coordinator speaks with.'
            )}
          </p>
        </div>
        <Select
          value={control.coordinatorVoice}
          onValueChange={(value: OpenAiRealtimeVoice) => updateControl({ coordinatorVoice: value })}
        >
          <SelectTrigger
            size="sm"
            className="w-52 shrink-0"
            aria-label={translate(
              'auto.components.settings.VoiceControlSettingsSection.bcc40a5cfc',
              'Coordinator voice'
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPENAI_REALTIME_VOICES.map((voice) => (
              <SelectItem key={voice} value={voice}>
                {formatCoordinatorVoiceName(voice)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-4 py-2">
        <div className="min-w-0 space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.VoiceControlSettingsSection.5c549e4dde',
              'Agent updates'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.VoiceControlSettingsSection.8ec9e8d099',
              "A session's voice is locked once the first reply plays, so agents can't sound different. Choose whether the coordinator names the reporting agent when relaying updates."
            )}
          </p>
        </div>
        <Select
          value={control.agentVoiceMode}
          onValueChange={(value: VoiceControlAgentVoiceMode) =>
            updateControl({ agentVoiceMode: value })
          }
        >
          <SelectTrigger
            size="sm"
            className="w-52 shrink-0"
            aria-label={translate(
              'auto.components.settings.VoiceControlSettingsSection.5c549e4dde',
              'Agent updates'
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="per-agent">
              {translate(
                'auto.components.settings.VoiceControlSettingsSection.96dc2a9896',
                'Name the reporting agent'
              )}
            </SelectItem>
            <SelectItem value="coordinator">
              {translate(
                'auto.components.settings.VoiceControlSettingsSection.fb987e9167',
                'Relay updates without naming agents'
              )}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-4 py-2">
        <div className="min-w-0 space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.VoiceControlSettingsSection.44af9d4285',
              'Max session length'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.VoiceControlSettingsSection.87a0e3370b',
              'Voice control hangs up automatically at this limit. Choose Unlimited for no cap.'
            )}
          </p>
        </div>
        <Select
          value={String(control.maxSessionMinutes)}
          onValueChange={(value) => updateControl({ maxSessionMinutes: Number(value) })}
        >
          <SelectTrigger
            size="sm"
            className="w-52 shrink-0"
            aria-label={translate(
              'auto.components.settings.VoiceControlSettingsSection.44af9d4285',
              'Max session length'
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MAX_SESSION_MINUTE_OPTIONS.map((minutes) => (
              <SelectItem key={minutes} value={String(minutes)}>
                {maxSessionMinutesLabel(minutes)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5 py-2">
        <Label htmlFor="settings-voice-control-custom-instructions">
          {translate(
            'auto.components.settings.VoiceControlSettingsSection.95d6edeaf0',
            'Custom instructions'
          )}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.VoiceControlSettingsSection.6103f118f5',
            'Persona and style notes for the control, appended to its built-in rules. Applies to new sessions.'
          )}
        </p>
        <Textarea
          id="settings-voice-control-custom-instructions"
          value={customInstructionsDraft}
          onChange={(event) => setCustomInstructionsDraft(event.target.value)}
          onBlur={() => updateControl({ customInstructions: customInstructionsDraft })}
          placeholder={translate(
            'auto.components.settings.VoiceControlSettingsSection.0173d1898d',
            'Example: keep every answer to one sentence.'
          )}
          rows={3}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>

      <p className="py-2 text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.VoiceControlSettingsSection.2ab4f49ef3',
          'Realtime audio is billed per minute of session time.'
        )}
      </p>
    </>
  )
}
