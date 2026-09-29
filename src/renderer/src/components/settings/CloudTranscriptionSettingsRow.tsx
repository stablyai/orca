import { CheckCircle2, Cloud, Unlink } from 'lucide-react'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'
import {
  getCloudTranscriptionProviderLabel,
  type CloudTranscriptionProvider
} from './cloud-transcription-provider'

type CloudTranscriptionSettingsRowProps = {
  provider: CloudTranscriptionProvider
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
}: CloudTranscriptionSettingsRowProps): React.JSX.Element {
  const providerLabel = getCloudTranscriptionProviderLabel(provider)
  const disconnectLabel = translate(
    'auto.components.settings.CloudTranscriptionSettingsRow.disconnect',
    'Disconnect {{provider}} API key',
    { provider: providerLabel }
  )
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <Cloud className="size-4 shrink-0 text-muted-foreground" />
          <Label>
            {translate(
              'auto.components.settings.CloudTranscriptionSettingsRow.title',
              '{{provider}} Transcription',
              { provider: providerLabel }
            )}
          </Label>
          {configured && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3.5" />
              {translate(
                'auto.components.settings.OpenAiTranscriptionSettingsRow.3b0ab3fc0b',
                'Connected'
              )}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {configured
            ? translate(
                'auto.components.settings.OpenAiTranscriptionSettingsRow.b59b9b2b51',
                'API key configured for cloud speech-to-text models.'
              )
            : translate(
                'auto.components.settings.CloudTranscriptionSettingsRow.addKeyDescription',
                'Add an API key before selecting {{provider}} speech-to-text models.',
                { provider: providerLabel }
              )}
        </p>
      </div>
      {configured ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={disabled} onClick={onConfigure}>
            {translate(
              'auto.components.settings.OpenAiTranscriptionSettingsRow.a622bc3b37',
              'Replace key'
            )}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onClear}
                aria-label={disconnectLabel}
                disabled={disabled}
              >
                <Unlink className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{disconnectLabel}</TooltipContent>
          </Tooltip>
        </div>
      ) : (
        <Button variant="outline" size="sm" disabled={disabled} onClick={onConfigure}>
          {translate(
            'auto.components.settings.OpenAiTranscriptionSettingsRow.85c589cd61',
            'Add API key'
          )}
        </Button>
      )}
    </div>
  )
}
