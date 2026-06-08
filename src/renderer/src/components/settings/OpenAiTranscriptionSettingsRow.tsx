import { CheckCircle2, Cloud, Unlink } from 'lucide-react'
import { Button } from '../ui/button'
import { Label } from '../ui/label'

type OpenAiTranscriptionSettingsRowProps = {
  configured: boolean
  disabled: boolean
  onConfigure: () => void
  onClear: () => void
}

export function OpenAiTranscriptionSettingsRow({
  configured,
  disabled,
  onConfigure,
  onClear
}: OpenAiTranscriptionSettingsRowProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <Cloud className="size-4 shrink-0 text-muted-foreground" />
          <Label>OpenAI Transcription</Label>
          {configured && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3.5" />
              Connected
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {configured
            ? 'API key configured for cloud speech-to-text models.'
            : 'Add an OpenAI API key before selecting cloud speech-to-text models.'}
        </p>
      </div>
      {configured ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={disabled} onClick={onConfigure}>
            Replace key
          </Button>
          <button
            onClick={onClear}
            aria-label="Disconnect OpenAI API key"
            disabled={disabled}
            className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Unlink className="size-3.5" />
          </button>
        </div>
      ) : (
        <Button variant="outline" size="sm" disabled={disabled} onClick={onConfigure}>
          Add API key
        </Button>
      )}
    </div>
  )
}
