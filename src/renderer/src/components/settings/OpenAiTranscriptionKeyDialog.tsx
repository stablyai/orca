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

type OpenAiTranscriptionKeyDialogProps = {
  open: boolean
  configured: boolean
  apiKeyDraft: string
  pending: boolean
  onOpenChange: (open: boolean) => void
  onApiKeyDraftChange: (value: string) => void
  onSave: () => void
  onClear: () => void
}

export function OpenAiTranscriptionKeyDialog({
  open,
  configured,
  apiKeyDraft,
  pending,
  onOpenChange,
  onApiKeyDraftChange,
  onSave,
  onClear
}: OpenAiTranscriptionKeyDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.OpenAiTranscriptionKeyDialog.439e91879e',
              'OpenAI Transcription'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.OpenAiTranscriptionKeyDialog.07ed3e512e',
              'Audio is sent to OpenAI only when an OpenAI speech model is selected.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="openai-speech-api-key">
            {translate(
              'auto.components.settings.OpenAiTranscriptionKeyDialog.16015322f9',
              'API Key'
            )}
          </Label>
          <Input
            id="openai-speech-api-key"
            type="password"
            value={apiKeyDraft}
            placeholder={
              configured
                ? translate(
                    'auto.components.settings.OpenAiTranscriptionKeyDialog.2f797018f0',
                    'API key configured'
                  )
                : translate(
                    'auto.components.settings.OpenAiTranscriptionKeyDialog.c3380e4ca5',
                    'sk-...'
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
            'auto.components.settings.OpenAiTranscriptionKeyDialog.d246b2bdb3',
            'Local runtime keys are stored in ~/.orca using Electron encrypted storage when available.'
          )}
        </p>
        <DialogFooter>
          {configured && (
            <Button variant="outline" disabled={pending} onClick={onClear}>
              {translate(
                'auto.components.settings.OpenAiTranscriptionKeyDialog.07b26f2742',
                'Clear Key'
              )}
            </Button>
          )}
          <Button disabled={pending || !apiKeyDraft.trim()} onClick={onSave}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {translate(
              'auto.components.settings.OpenAiTranscriptionKeyDialog.fa83512e48',
              'Save Key'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
