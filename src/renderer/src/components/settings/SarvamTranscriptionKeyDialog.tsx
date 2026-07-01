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

type SarvamTranscriptionKeyDialogProps = {
  open: boolean
  configured: boolean
  apiKeyDraft: string
  pending: boolean
  onOpenChange: (open: boolean) => void
  onApiKeyDraftChange: (value: string) => void
  onSave: () => void
  onClear: () => void
}

export function SarvamTranscriptionKeyDialog({
  open,
  configured,
  apiKeyDraft,
  pending,
  onOpenChange,
  onApiKeyDraftChange,
  onSave,
  onClear
}: SarvamTranscriptionKeyDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.SarvamTranscriptionKeyDialog.title',
              'Sarvam Transcription'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.SarvamTranscriptionKeyDialog.description',
              'Audio streams to Sarvam only when a Sarvam speech model is selected. Supports 23 Indian languages and English with auto-detect.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="sarvam-speech-api-key">
            {translate('auto.components.settings.SarvamTranscriptionKeyDialog.apiKey', 'API Key')}
          </Label>
          <Input
            id="sarvam-speech-api-key"
            type="password"
            value={apiKeyDraft}
            placeholder={
              configured
                ? translate(
                    'auto.components.settings.SarvamTranscriptionKeyDialog.placeholderConfigured',
                    'API key configured'
                  )
                : translate(
                    'auto.components.settings.SarvamTranscriptionKeyDialog.placeholder',
                    'Sarvam API subscription key'
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
            'auto.components.settings.SarvamTranscriptionKeyDialog.storage',
            'Local runtime keys are stored in ~/.orca using Electron encrypted storage when available.'
          )}
        </p>
        <DialogFooter>
          {configured && (
            <Button variant="outline" disabled={pending} onClick={onClear}>
              {translate(
                'auto.components.settings.SarvamTranscriptionKeyDialog.clear',
                'Clear Key'
              )}
            </Button>
          )}
          <Button disabled={pending || !apiKeyDraft.trim()} onClick={onSave}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {translate('auto.components.settings.SarvamTranscriptionKeyDialog.save', 'Save Key')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
