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

type Props = {
  provider: 'openai' | 'soniox'
  open: boolean
  configured: boolean
  apiKeyDraft: string
  pending: boolean
  onOpenChange: (open: boolean) => void
  onApiKeyDraftChange: (value: string) => void
  onSave: () => void
  onClear: () => void
}

export function CloudTranscriptionKeyDialog({
  provider,
  open,
  configured,
  apiKeyDraft,
  pending,
  onOpenChange,
  onApiKeyDraftChange,
  onSave,
  onClear
}: Props): React.JSX.Element {
  const isOpenAi = provider === 'openai'
  const title = isOpenAi
    ? translate(
        'auto.components.settings.OpenAiTranscriptionKeyDialog.439e91879e',
        'OpenAI Transcription'
      )
    : translate(
        'auto.components.settings.SonioxTranscriptionKeyDialog.title',
        'Soniox Transcription'
      )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {isOpenAi
              ? translate(
                  'auto.components.settings.OpenAiTranscriptionKeyDialog.07ed3e512e',
                  'Audio is sent to OpenAI only when an OpenAI speech model is selected.'
                )
              : translate(
                  'auto.components.settings.SonioxTranscriptionKeyDialog.description',
                  'Audio is streamed to Soniox only when a Soniox speech model is selected.'
                )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`${provider}-speech-api-key`}>
            {isOpenAi
              ? translate(
                  'auto.components.settings.OpenAiTranscriptionKeyDialog.16015322f9',
                  'API Key'
                )
              : translate(
                  'auto.components.settings.SonioxTranscriptionKeyDialog.apiKey',
                  'API Key'
                )}
          </Label>
          <Input
            id={`${provider}-speech-api-key`}
            type="password"
            value={apiKeyDraft}
            placeholder={
              configured
                ? isOpenAi
                  ? translate(
                      'auto.components.settings.OpenAiTranscriptionKeyDialog.2f797018f0',
                      'API key configured'
                    )
                  : translate(
                      'auto.components.settings.SonioxTranscriptionKeyDialog.configured',
                      'API key configured'
                    )
                : isOpenAi
                  ? translate(
                      'auto.components.settings.OpenAiTranscriptionKeyDialog.c3380e4ca5',
                      'sk-...'
                    )
                  : translate(
                      'auto.components.settings.SonioxTranscriptionKeyDialog.placeholder',
                      'Enter Soniox API key'
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
          {isOpenAi
            ? translate(
                'auto.components.settings.OpenAiTranscriptionKeyDialog.d246b2bdb3',
                'Local runtime keys are stored in ~/.orca using Electron encrypted storage when available.'
              )
            : translate(
                'auto.components.settings.SonioxTranscriptionKeyDialog.storage',
                'Local runtime keys are stored in ~/.orca using Electron encrypted storage when available.'
              )}
        </p>
        <DialogFooter>
          {configured && (
            <Button variant="outline" disabled={pending} onClick={onClear}>
              {isOpenAi
                ? translate(
                    'auto.components.settings.OpenAiTranscriptionKeyDialog.07b26f2742',
                    'Clear Key'
                  )
                : translate(
                    'auto.components.settings.SonioxTranscriptionKeyDialog.clear',
                    'Clear Key'
                  )}
            </Button>
          )}
          <Button disabled={pending || !apiKeyDraft.trim()} onClick={onSave}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {isOpenAi
              ? translate(
                  'auto.components.settings.OpenAiTranscriptionKeyDialog.fa83512e48',
                  'Save Key'
                )
              : translate('auto.components.settings.SonioxTranscriptionKeyDialog.save', 'Save Key')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
