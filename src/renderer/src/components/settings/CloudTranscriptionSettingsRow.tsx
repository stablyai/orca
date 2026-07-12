import { CheckCircle2, Cloud, Unlink } from 'lucide-react'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'

type Props = {
  provider: 'openai' | 'soniox'
  configured: boolean
  disabled: boolean
  onConfigure: () => void
  onClear: () => void
}

export function CloudTranscriptionSettingsRow({
  provider,
  configured,
  disabled,
  onConfigure,
  onClear
}: Props): React.JSX.Element {
  const isOpenAi = provider === 'openai'
  const label = isOpenAi
    ? translate(
        'auto.components.settings.OpenAiTranscriptionSettingsRow.27e0cb656d',
        'OpenAI Transcription'
      )
    : translate(
        'auto.components.settings.SonioxTranscriptionSettingsRow.title',
        'Soniox Transcription'
      )
  const disconnectLabel = isOpenAi
    ? translate(
        'auto.components.settings.OpenAiTranscriptionSettingsRow.ae2df8f511',
        'Disconnect OpenAI API key'
      )
    : translate(
        'auto.components.settings.SonioxTranscriptionSettingsRow.disconnect',
        'Disconnect Soniox API key'
      )

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <Cloud className="size-4 shrink-0 text-muted-foreground" />
          <Label>{label}</Label>
          {configured && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3.5" />
              {isOpenAi
                ? translate(
                    'auto.components.settings.OpenAiTranscriptionSettingsRow.3b0ab3fc0b',
                    'Connected'
                  )
                : translate(
                    'auto.components.settings.SonioxTranscriptionSettingsRow.connected',
                    'Connected'
                  )}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {isOpenAi
            ? configured
              ? translate(
                  'auto.components.settings.OpenAiTranscriptionSettingsRow.b59b9b2b51',
                  'API key configured for cloud speech-to-text models.'
                )
              : translate(
                  'auto.components.settings.OpenAiTranscriptionSettingsRow.893790e13b',
                  'Add an OpenAI API key before selecting cloud speech-to-text models.'
                )
            : configured
              ? translate(
                  'auto.components.settings.SonioxTranscriptionSettingsRow.keyReady',
                  'API key configured for Soniox speech-to-text models.'
                )
              : translate(
                  'auto.components.settings.SonioxTranscriptionSettingsRow.keyRequired',
                  'Add a Soniox API key before selecting Soniox speech-to-text models.'
                )}
        </p>
      </div>
      {configured ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={disabled} onClick={onConfigure}>
            {isOpenAi
              ? translate(
                  'auto.components.settings.OpenAiTranscriptionSettingsRow.a622bc3b37',
                  'Replace key'
                )
              : translate(
                  'auto.components.settings.SonioxTranscriptionSettingsRow.replace',
                  'Replace key'
                )}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClear}
                aria-label={disconnectLabel}
                disabled={disabled}
                className="text-muted-foreground hover:text-destructive"
              >
                <Unlink className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {disconnectLabel}
            </TooltipContent>
          </Tooltip>
        </div>
      ) : (
        <Button variant="outline" size="sm" disabled={disabled} onClick={onConfigure}>
          {isOpenAi
            ? translate(
                'auto.components.settings.OpenAiTranscriptionSettingsRow.85c589cd61',
                'Add API key'
              )
            : translate(
                'auto.components.settings.SonioxTranscriptionSettingsRow.add',
                'Add API key'
              )}
        </Button>
      )}
    </div>
  )
}
