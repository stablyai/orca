import { CheckCircle2, Cloud, Unlink } from 'lucide-react'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'

type DeepgramTranscriptionSettingsRowProps = {
  configured: boolean
  disabled: boolean
  onConfigure: () => void
  onClear: () => void
}

export function DeepgramTranscriptionSettingsRow({
  configured,
  disabled,
  onConfigure,
  onClear
}: DeepgramTranscriptionSettingsRowProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <Cloud className="size-4 shrink-0 text-muted-foreground" />
          <Label>
            {translate(
              'auto.components.settings.DeepgramTranscriptionSettingsRow.label',
              'Deepgram Transcription'
            )}
          </Label>
          {configured && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3.5" />
              {translate(
                'auto.components.settings.DeepgramTranscriptionSettingsRow.connected',
                'Connected'
              )}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {configured
            ? translate(
                'auto.components.settings.DeepgramTranscriptionSettingsRow.configuredDescription',
                'API key configured for Deepgram Nova-3.'
              )
            : translate(
                'auto.components.settings.DeepgramTranscriptionSettingsRow.unconfiguredDescription',
                'Add a Deepgram API key before selecting Deepgram Nova-3.'
              )}
        </p>
      </div>
      {configured ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={disabled} onClick={onConfigure}>
            {translate(
              'auto.components.settings.DeepgramTranscriptionSettingsRow.replaceKey',
              'Replace key'
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClear}
            aria-label={translate(
              'auto.components.settings.DeepgramTranscriptionSettingsRow.disconnectKey',
              'Disconnect Deepgram API key'
            )}
            disabled={disabled}
            className="text-muted-foreground/50 hover:text-destructive"
          >
            <Unlink className="size-3.5" />
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" disabled={disabled} onClick={onConfigure}>
          {translate(
            'auto.components.settings.DeepgramTranscriptionSettingsRow.addKey',
            'Add API key'
          )}
        </Button>
      )}
    </div>
  )
}
