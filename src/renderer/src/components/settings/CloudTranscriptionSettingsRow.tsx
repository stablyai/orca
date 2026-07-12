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

type ProviderCopy = {
  label: string
  disconnectLabel: string
  connectedLabel: string
  descriptionConfigured: string
  descriptionEmpty: string
  replaceLabel: string
  addLabel: string
}

// Why: resolve copy during render so locale switches pick up new strings.
function getProviderCopy(provider: Props['provider']): ProviderCopy {
  if (provider === 'openai') {
    return {
      label: translate(
        'auto.components.settings.OpenAiTranscriptionSettingsRow.27e0cb656d',
        'OpenAI Transcription'
      ),
      disconnectLabel: translate(
        'auto.components.settings.OpenAiTranscriptionSettingsRow.ae2df8f511',
        'Disconnect OpenAI API key'
      ),
      connectedLabel: translate(
        'auto.components.settings.OpenAiTranscriptionSettingsRow.3b0ab3fc0b',
        'Connected'
      ),
      descriptionConfigured: translate(
        'auto.components.settings.OpenAiTranscriptionSettingsRow.b59b9b2b51',
        'API key configured for cloud speech-to-text models.'
      ),
      descriptionEmpty: translate(
        'auto.components.settings.OpenAiTranscriptionSettingsRow.893790e13b',
        'Add an OpenAI API key before selecting cloud speech-to-text models.'
      ),
      replaceLabel: translate(
        'auto.components.settings.OpenAiTranscriptionSettingsRow.a622bc3b37',
        'Replace key'
      ),
      addLabel: translate(
        'auto.components.settings.OpenAiTranscriptionSettingsRow.85c589cd61',
        'Add API key'
      )
    }
  }

  return {
    label: translate(
      'auto.components.settings.CloudTranscriptionSettingsRow.9204b6af01',
      'Soniox Transcription'
    ),
    disconnectLabel: translate(
      'auto.components.settings.CloudTranscriptionSettingsRow.aca467793b',
      'Disconnect Soniox API key'
    ),
    connectedLabel: translate(
      'auto.components.settings.CloudTranscriptionSettingsRow.a0ee84fe16',
      'Connected'
    ),
    descriptionConfigured: translate(
      'auto.components.settings.CloudTranscriptionSettingsRow.51e2076cc0',
      'API key configured for Soniox speech-to-text models.'
    ),
    descriptionEmpty: translate(
      'auto.components.settings.CloudTranscriptionSettingsRow.ec74cedecf',
      'Add a Soniox API key before selecting Soniox speech-to-text models.'
    ),
    replaceLabel: translate(
      'auto.components.settings.CloudTranscriptionSettingsRow.6e1c455419',
      'Replace key'
    ),
    addLabel: translate(
      'auto.components.settings.CloudTranscriptionSettingsRow.16c340cfdb',
      'Add API key'
    )
  }
}

export function CloudTranscriptionSettingsRow({
  provider,
  configured,
  disabled,
  onConfigure,
  onClear
}: Props): React.JSX.Element {
  const copy = getProviderCopy(provider)

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <Cloud className="size-4 shrink-0 text-muted-foreground" />
          <Label>{copy.label}</Label>
          {configured && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3.5" />
              {copy.connectedLabel}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {configured ? copy.descriptionConfigured : copy.descriptionEmpty}
        </p>
      </div>
      {configured ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={disabled} onClick={onConfigure}>
            {copy.replaceLabel}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClear}
                aria-label={copy.disconnectLabel}
                disabled={disabled}
                className="text-muted-foreground hover:text-destructive"
              >
                <Unlink className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {copy.disconnectLabel}
            </TooltipContent>
          </Tooltip>
        </div>
      ) : (
        <Button variant="outline" size="sm" disabled={disabled} onClick={onConfigure}>
          {copy.addLabel}
        </Button>
      )}
    </div>
  )
}
