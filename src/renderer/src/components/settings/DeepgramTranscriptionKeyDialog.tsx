import { ExternalLink, Loader2, Lock } from 'lucide-react'
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

type DeepgramTranscriptionKeyDialogProps = {
  open: boolean
  configured: boolean
  apiKeyDraft: string
  pending: boolean
  onOpenChange: (open: boolean) => void
  onApiKeyDraftChange: (value: string) => void
  onSave: () => void
  onClear: () => void
}

export function DeepgramTranscriptionKeyDialog({
  open,
  configured,
  apiKeyDraft,
  pending,
  onOpenChange,
  onApiKeyDraftChange,
  onSave,
  onClear
}: DeepgramTranscriptionKeyDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.DeepgramTranscriptionKeyDialog.title',
              'Deepgram Transcription'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.DeepgramTranscriptionKeyDialog.description',
              'Audio is sent to Deepgram only when Deepgram Nova-3 is selected.'
            )}{' '}
            <a
              href="https://console.deepgram.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
            >
              {translate(
                'auto.components.settings.DeepgramTranscriptionKeyDialog.consoleLink',
                'Open Deepgram Console'
              )}
              <ExternalLink className="size-3" />
            </a>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="deepgram-speech-api-key">
            {translate(
              'auto.components.settings.DeepgramTranscriptionKeyDialog.apiKeyLabel',
              'API Key'
            )}
          </Label>
          <Input
            id="deepgram-speech-api-key"
            type="password"
            value={apiKeyDraft}
            placeholder={
              configured
                ? translate(
                    'auto.components.settings.DeepgramTranscriptionKeyDialog.configuredPlaceholder',
                    'API key configured'
                  )
                : translate(
                    'auto.components.settings.DeepgramTranscriptionKeyDialog.apiKeyPlaceholder',
                    'Deepgram API key'
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
            'auto.components.settings.DeepgramTranscriptionKeyDialog.encryptionHint',
            'Requires Electron encrypted credential storage. Your key is never stored in plaintext.'
          )}
        </p>
        <DialogFooter>
          {configured && (
            <Button variant="outline" disabled={pending} onClick={onClear}>
              {translate(
                'auto.components.settings.DeepgramTranscriptionKeyDialog.clearKey',
                'Clear Key'
              )}
            </Button>
          )}
          <Button disabled={pending || !apiKeyDraft.trim()} onClick={onSave}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {translate(
              'auto.components.settings.DeepgramTranscriptionKeyDialog.saveKey',
              'Save Key'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
