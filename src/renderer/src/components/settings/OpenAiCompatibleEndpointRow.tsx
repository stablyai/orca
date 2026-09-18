import { Server } from 'lucide-react'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'
import type { OpenAiCompatibleSettings } from '../../../../shared/speech-types'

type OpenAiCompatibleEndpointRowProps = {
  settings: OpenAiCompatibleSettings
  disabled: boolean
  onChange: (next: OpenAiCompatibleSettings) => void
}

/**
 * Points cloud dictation at any OpenAI-compatible transcription service
 * (Groq, OpenRouter, a self-hosted Whisper). Empty base URL = OpenAI.
 */
export function OpenAiCompatibleEndpointRow({
  settings,
  disabled,
  onChange
}: OpenAiCompatibleEndpointRowProps): React.JSX.Element {
  return (
    <div className="space-y-2 py-2">
      <div className="flex items-center gap-2">
        <Server className="size-4 shrink-0 text-muted-foreground" />
        <Label htmlFor="openai-compatible-base-url">
          {translate(
            'auto.components.settings.OpenAiCompatibleEndpointRow.a1b2c3d4e5',
            'OpenAI-compatible endpoint'
          )}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.OpenAiCompatibleEndpointRow.b2c3d4e5f6',
          'Send cloud dictation to another service that speaks the OpenAI transcription API — Groq, OpenRouter or a local Whisper server. Leave empty to use OpenAI. The API key above is sent as the bearer token; a keyless local server needs none.'
        )}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          id="openai-compatible-base-url"
          value={settings.baseUrl}
          disabled={disabled}
          spellCheck={false}
          placeholder={translate(
            'auto.components.settings.OpenAiCompatibleEndpointRow.d4e5f6a7b8',
            'https://api.groq.com/openai/v1/audio/transcriptions'
          )}
          onChange={(event) => onChange({ ...settings, baseUrl: event.target.value })}
        />
        <Input
          id="openai-compatible-model"
          value={settings.model}
          disabled={disabled}
          spellCheck={false}
          placeholder={translate(
            'auto.components.settings.OpenAiCompatibleEndpointRow.c3d4e5f6a7',
            'Model name, e.g. whisper-large-v3-turbo'
          )}
          onChange={(event) => onChange({ ...settings, model: event.target.value })}
        />
      </div>
    </div>
  )
}
