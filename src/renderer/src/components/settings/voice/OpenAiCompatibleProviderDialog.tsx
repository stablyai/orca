import { useEffect, useState } from 'react'
import { Loader2, Lock } from 'lucide-react'
import { toast } from 'sonner'
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
import { readIpcErrorMessage } from '@/lib/ipc-error'
import type { OpenAiCompatibleSpeechProviderSummary } from '../../../../../shared/speech-types'

type OpenAiCompatibleProviderDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

export function OpenAiCompatibleProviderDialog({
  open,
  onOpenChange,
  onSaved
}: OpenAiCompatibleProviderDialogProps): React.JSX.Element {
  const t = useTranslate()
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saved, setSaved] = useState<OpenAiCompatibleSpeechProviderSummary | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setApiKey('')
    void window.api.speech
      .getOpenAiCompatibleProvider()
      .then((summary) => {
        if (cancelled) {
          return
        }
        setBaseUrl(summary?.baseUrl ?? '')
        setModel(summary?.model ?? '')
        setSaved(summary)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open])

  const canSave = !pending && baseUrl.trim() !== '' && model.trim() !== ''
  const keepsSavedKey = saved?.hasApiKey === true && saved.baseUrl === baseUrl.trim()

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!canSave) {
      return
    }
    setPending(true)
    try {
      await window.api.speech.saveOpenAiCompatibleProvider({ baseUrl, model, apiKey })
      onSaved()
      onOpenChange(false)
    } catch (err) {
      toast.error(
        readIpcErrorMessage(err) ??
          t(
            'components.settings.voice.openAiCompatible.updateFailed',
            'Could not update the provider'
          )
      )
    }
    setPending(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('components.settings.voice.openAiCompatible.title', 'OpenAI-compatible provider')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'components.settings.voice.openAiCompatible.description',
              'Audio goes to this service only while the OpenAI-compatible model is selected. It works with Groq, Mistral, OpenAI and local servers.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(event) => void save(event)}>
          <div className="space-y-2">
            <Label htmlFor="openai-compatible-base-url">
              {t('components.settings.voice.openAiCompatible.baseUrl', 'Base URL')}
            </Label>
            <Input
              id="openai-compatible-base-url"
              value={baseUrl}
              placeholder={t(
                'components.settings.voice.openAiCompatible.baseUrlPlaceholder',
                'https://api.groq.com/openai/v1'
              )}
              spellCheck={false}
              disabled={pending}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="openai-compatible-model">
              {t('components.settings.voice.openAiCompatible.model', 'Model')}
            </Label>
            <Input
              id="openai-compatible-model"
              value={model}
              placeholder={t(
                'components.settings.voice.openAiCompatible.modelPlaceholder',
                'whisper-large-v3-turbo'
              )}
              spellCheck={false}
              disabled={pending}
              onChange={(event) => setModel(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="openai-compatible-api-key">
              {t('components.settings.voice.openAiCompatible.apiKey', 'API Key')}
            </Label>
            <Input
              id="openai-compatible-api-key"
              type="password"
              value={apiKey}
              placeholder={
                keepsSavedKey
                  ? t('components.settings.voice.openAiCompatible.keySaved', 'Saved key kept')
                  : t(
                      'components.settings.voice.openAiCompatible.keyOptional',
                      'Optional for local servers'
                    )
              }
              disabled={pending}
              onChange={(event) => setApiKey(event.target.value)}
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
            <Button type="submit" disabled={!canSave}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('components.settings.voice.openAiCompatible.save', 'Save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
