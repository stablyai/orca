import { Loader2, Lock } from 'lucide-react'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { useTranslate } from '@/i18n/use-translate'

type OpenAiTranscriptionKeyDialogProps = {
  /** Whose key this is; the dialog only differs in its copy. */
  provider?: 'openai' | 'soniox'
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
  provider = 'openai',
  open,
  configured,
  apiKeyDraft,
  pending,
  onOpenChange,
  onApiKeyDraftChange,
  onSave,
  onClear
}: OpenAiTranscriptionKeyDialogProps): React.JSX.Element {
  const t = useTranslate()
  const soniox = provider === 'soniox'
  const inputId = `${provider}-speech-api-key`
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {soniox
              ? t('components.settings.voice.soniox.title', 'Soniox real-time transcription')
              : t(
                  'auto.components.settings.OpenAiTranscriptionKeyDialog.bf1ff9c891',
                  'OpenAI transcription'
                )}
          </DialogTitle>
          <DialogDescription>
            {soniox
              ? t(
                  'components.settings.voice.soniox.description',
                  'Audio streams to Soniox only while the Soniox model is selected, and words appear as you speak.'
                )
              : t(
                  'auto.components.settings.OpenAiTranscriptionKeyDialog.07ed3e512e',
                  'Audio is sent to OpenAI only when an OpenAI speech model is selected.'
                )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={inputId}>
            {t('auto.components.settings.OpenAiTranscriptionKeyDialog.c3dfb3840e', 'API key')}
          </Label>
          <Input
            id={inputId}
            type="password"
            value={apiKeyDraft}
            placeholder={
              configured
                ? t(
                    'auto.components.settings.OpenAiTranscriptionKeyDialog.2f797018f0',
                    'API key configured'
                  )
                : soniox
                  ? ''
                  : t('auto.components.settings.OpenAiTranscriptionKeyDialog.c3380e4ca5', 'sk-...')
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
          {t(
            'auto.components.settings.OpenAiTranscriptionKeyDialog.d246b2bdb3',
            'Local runtime keys are stored in ~/.orca using Electron encrypted storage when available.'
          )}
        </p>
        <DialogFooter>
          {configured && (
            <Button variant="outline" disabled={pending} onClick={onClear}>
              {t('auto.components.settings.OpenAiTranscriptionKeyDialog.be6c3f2eba', 'Clear key')}
            </Button>
          )}
          <Button disabled={pending || !apiKeyDraft.trim()} onClick={onSave}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('auto.components.settings.OpenAiTranscriptionKeyDialog.bce1b6d18a', 'Save key')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
