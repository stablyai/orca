import { Loader2, Lock } from 'lucide-react'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'

type ElevenLabsTranscriptionKeyDialogProps = {
  open: boolean
  configured: boolean
  apiKeyDraft: string
  pending: boolean
  onOpenChange: (open: boolean) => void
  onApiKeyDraftChange: (value: string) => void
  onSave: () => void
  onClear: () => void
}

export function ElevenLabsTranscriptionKeyDialog({
  open,
  configured,
  apiKeyDraft,
  pending,
  onOpenChange,
  onApiKeyDraftChange,
  onSave,
  onClear
}: ElevenLabsTranscriptionKeyDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.ElevenLabsTranscriptionKeyDialog.229c3e3d71',
              'ElevenLabs Transcription'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.ElevenLabsTranscriptionKeyDialog.97aca13c79',
              'Audio is sent to ElevenLabs only when an ElevenLabs speech model is selected.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="elevenlabs-speech-api-key">
            {translate(
              'auto.components.settings.ElevenLabsTranscriptionKeyDialog.05552652fe',
              'API Key'
            )}
          </Label>
          <Input
            id="elevenlabs-speech-api-key"
            type="password"
            value={apiKeyDraft}
            placeholder={
              configured
                ? translate(
                    'auto.components.settings.ElevenLabsTranscriptionKeyDialog.0537b3d6ea',
                    'API key configured'
                  )
                : translate(
                    'auto.components.settings.ElevenLabsTranscriptionKeyDialog.7e3b18261e',
                    'sk_...'
                  )
            }
            disabled={pending}
            onChange={(event) => onApiKeyDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && apiKeyDraft.trim()) {
                onSave()
              }
            }}
          />
        </div>
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
          <Lock className="size-3 shrink-0" />
          {translate(
            'auto.components.settings.ElevenLabsTranscriptionKeyDialog.c6579737f7',
            'Local runtime keys are stored in ~/.orca using Electron encrypted storage when available.'
          )}
        </p>
        <DialogFooter>
          {configured && (
            <Button variant="outline" disabled={pending} onClick={onClear}>
              {translate(
                'auto.components.settings.ElevenLabsTranscriptionKeyDialog.2c25731e54',
                'Clear Key'
              )}
            </Button>
          )}
          <Button disabled={pending || !apiKeyDraft.trim()} onClick={onSave}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {translate(
              'auto.components.settings.ElevenLabsTranscriptionKeyDialog.79cb03e588',
              'Save Key'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
