import { CheckCircle2, Cloud, Unlink } from 'lucide-react'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'

type OpenAiTranscriptionSettingsRowProps = {
  /** 'compatible' is the base URL + model provider, set up in its own dialog. */
  variant?: 'openai' | 'compatible'
  configured: boolean
  disabled: boolean
  onConfigure: () => void
  onClear: () => void
  className?: string
}

export function OpenAiTranscriptionSettingsRow({
  variant = 'openai',
  configured,
  disabled,
  onConfigure,
  onClear,
  className
}: OpenAiTranscriptionSettingsRowProps): React.JSX.Element {
  const t = useTranslate()
  const copy =
    variant === 'compatible'
      ? {
          title: t(
            'components.settings.voice.openAiCompatible.title',
            'OpenAI-compatible provider'
          ),
          configured: t(
            'components.settings.voice.openAiCompatible.rowConfigured',
            'Base URL and model saved for the OpenAI-compatible model.'
          ),
          missing: t(
            'components.settings.voice.openAiCompatible.rowMissing',
            'Add a base URL and model before selecting the OpenAI-compatible model.'
          ),
          edit: t('components.settings.voice.openAiCompatible.edit', 'Edit'),
          clear: t(
            'components.settings.voice.openAiCompatible.removeLabel',
            'Remove OpenAI-compatible provider'
          ),
          add: t('components.settings.voice.openAiCompatible.setUp', 'Set up')
        }
      : {
          title: t(
            'auto.components.settings.OpenAiTranscriptionSettingsRow.ff28e99b54',
            'OpenAI transcription'
          ),
          configured: t(
            'auto.components.settings.OpenAiTranscriptionSettingsRow.b59b9b2b51',
            'API key configured for cloud speech-to-text models.'
          ),
          missing: t(
            'auto.components.settings.OpenAiTranscriptionSettingsRow.893790e13b',
            'Add an OpenAI API key before selecting cloud speech-to-text models.'
          ),
          edit: t(
            'auto.components.settings.OpenAiTranscriptionSettingsRow.a622bc3b37',
            'Replace key'
          ),
          clear: t(
            'auto.components.settings.OpenAiTranscriptionSettingsRow.ae2df8f511',
            'Disconnect OpenAI API key'
          ),
          add: t(
            'auto.components.settings.OpenAiTranscriptionSettingsRow.85c589cd61',
            'Add API key'
          )
        }

  return (
    <div
      data-settings-row=""
      className={cn('flex items-center justify-between gap-4 py-2', className)}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <Cloud className="size-4 shrink-0 text-muted-foreground" />
          <Label>{copy.title}</Label>
          {configured && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3.5" />
              {t('auto.components.settings.OpenAiTranscriptionSettingsRow.3b0ab3fc0b', 'Connected')}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {configured ? copy.configured : copy.missing}
        </p>
      </div>
      {configured ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={disabled} onClick={onConfigure}>
            {copy.edit}
          </Button>
          <button
            onClick={onClear}
            aria-label={copy.clear}
            disabled={disabled}
            className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Unlink className="size-3.5" />
          </button>
        </div>
      ) : (
        <Button variant="outline" size="sm" disabled={disabled} onClick={onConfigure}>
          {copy.add}
        </Button>
      )}
    </div>
  )
}
