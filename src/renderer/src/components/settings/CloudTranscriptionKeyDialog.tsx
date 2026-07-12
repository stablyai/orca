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

type ProviderCopy = {
  title: string
  description: string
  apiKeyLabel: string
  placeholderConfigured: string
  placeholderEmpty: string
  storageNote: string
  clearLabel: string
  saveLabel: string
}

// Why: resolve copy during render so locale switches pick up new strings.
function getProviderCopy(provider: Props['provider']): ProviderCopy {
  if (provider === 'openai') {
    return {
      title: translate(
        'auto.components.settings.OpenAiTranscriptionKeyDialog.439e91879e',
        'OpenAI Transcription'
      ),
      description: translate(
        'auto.components.settings.OpenAiTranscriptionKeyDialog.07ed3e512e',
        'Audio is sent to OpenAI only when an OpenAI speech model is selected.'
      ),
      apiKeyLabel: translate(
        'auto.components.settings.OpenAiTranscriptionKeyDialog.16015322f9',
        'API Key'
      ),
      placeholderConfigured: translate(
        'auto.components.settings.OpenAiTranscriptionKeyDialog.2f797018f0',
        'API key configured'
      ),
      placeholderEmpty: translate(
        'auto.components.settings.OpenAiTranscriptionKeyDialog.c3380e4ca5',
        'sk-...'
      ),
      storageNote: translate(
        'auto.components.settings.OpenAiTranscriptionKeyDialog.d246b2bdb3',
        'Local runtime keys are stored in ~/.orca using Electron encrypted storage when available.'
      ),
      clearLabel: translate(
        'auto.components.settings.OpenAiTranscriptionKeyDialog.07b26f2742',
        'Clear Key'
      ),
      saveLabel: translate(
        'auto.components.settings.OpenAiTranscriptionKeyDialog.fa83512e48',
        'Save Key'
      )
    }
  }

  return {
    title: translate(
      'auto.components.settings.CloudTranscriptionKeyDialog.04b7890fa1',
      'Soniox Transcription'
    ),
    description: translate(
      'auto.components.settings.CloudTranscriptionKeyDialog.0badd7b30b',
      'Audio is streamed to Soniox only when a Soniox speech model is selected.'
    ),
    apiKeyLabel: translate(
      'auto.components.settings.CloudTranscriptionKeyDialog.18607352b8',
      'API Key'
    ),
    placeholderConfigured: translate(
      'auto.components.settings.CloudTranscriptionKeyDialog.2cc7a7df08',
      'API key configured'
    ),
    placeholderEmpty: translate(
      'auto.components.settings.CloudTranscriptionKeyDialog.41707543bd',
      'Enter Soniox API key'
    ),
    storageNote: translate(
      'auto.components.settings.CloudTranscriptionKeyDialog.c622175794',
      'Local runtime keys are stored in ~/.orca using Electron encrypted storage when available.'
    ),
    clearLabel: translate(
      'auto.components.settings.CloudTranscriptionKeyDialog.7025764a6f',
      'Clear Key'
    ),
    saveLabel: translate(
      'auto.components.settings.CloudTranscriptionKeyDialog.7710bd07a1',
      'Save Key'
    )
  }
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
  const copy = getProviderCopy(provider)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`${provider}-speech-api-key`}>{copy.apiKeyLabel}</Label>
          <Input
            id={`${provider}-speech-api-key`}
            type="password"
            value={apiKeyDraft}
            placeholder={configured ? copy.placeholderConfigured : copy.placeholderEmpty}
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
          {copy.storageNote}
        </p>
        <DialogFooter>
          {configured && (
            <Button variant="outline" disabled={pending} onClick={onClear}>
              {copy.clearLabel}
            </Button>
          )}
          <Button disabled={pending || !apiKeyDraft.trim()} onClick={onSave}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {copy.saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
