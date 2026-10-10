import { useState } from 'react'
import { ExternalLink, Loader2, Lock } from 'lucide-react'
import type {
  CloudSpeechKeyStatus,
  CloudSpeechProviderInfo
} from '../../../../shared/cloud-speech-providers'
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
import { describeSpeechIpcError } from './voice-speech-ipc-error'

// Why: the parent remounts this per open (React key) so a draft never carries across providers.
type CloudSpeechProviderKeyDialogProps = {
  open: boolean
  provider: CloudSpeechProviderInfo | null
  status: CloudSpeechKeyStatus | undefined
  pending: boolean
  onOpenChange: (open: boolean) => void
  /** Rejects with the provider's verdict so the dialog can keep the draft and show it inline. */
  onSave: (apiKey: string, verify: boolean) => Promise<void>
}

export function CloudSpeechProviderKeyDialog({
  open,
  provider,
  status,
  pending,
  onOpenChange,
  onSave
}: CloudSpeechProviderKeyDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(true)
  // Why: covers the pane's post-save work too, so the button cannot re-submit before the dialog closes.
  const [submitting, setSubmitting] = useState(false)
  const [rejectedOnVerify, setRejectedOnVerify] = useState(false)

  const configured = status?.configured === true
  const busy = pending || submitting
  const canSubmit = !busy && draft.trim() !== ''

  const submit = async (verify: boolean): Promise<void> => {
    if (!canSubmit) {
      return
    }
    setError(null)
    setVerifying(verify)
    setSubmitting(true)
    try {
      await onSave(draft.trim(), verify)
    } catch (saveError) {
      setError(describeSpeechIpcError(saveError))
      setRejectedOnVerify(verify)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open && provider !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.CloudSpeechProviderKeyDialog.title',
              '{{provider}} API key',
              { provider: provider?.label ?? '' }
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.CloudSpeechProviderKeyDialog.description',
              'Audio is sent to {{provider}} only while one of its models is selected for dictation.',
              { provider: provider?.label ?? '' }
            )}
          </DialogDescription>
        </DialogHeader>
        {/* Why: short windows scroll the body; -m-1 p-1 keeps the input focus ring unclipped. */}
        <div className="-m-1 max-h-[calc(100vh-12rem)] space-y-4 overflow-y-auto scrollbar-sleek p-1">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="cloud-speech-api-key">
                {translate(
                  'auto.components.settings.OpenAiTranscriptionKeyDialog.16015322f9',
                  'API Key'
                )}
              </Label>
              {provider ? (
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  onClick={() => void window.api.shell.openUrl(provider.keyUrl)}
                >
                  {translate(
                    'auto.components.settings.CloudSpeechProviderKeyDialog.getKey',
                    'Get API key'
                  )}
                  <ExternalLink className="size-3" />
                </Button>
              ) : null}
            </div>
            <Input
              id="cloud-speech-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={draft}
              aria-invalid={error !== null}
              placeholder={
                configured && status?.hint
                  ? translate(
                      'auto.components.settings.CloudSpeechProviderKeyDialog.replacePlaceholder',
                      'Replace key ending {{hint}}',
                      { hint: status.hint }
                    )
                  : (provider?.keyPlaceholder ?? '')
              }
              disabled={busy}
              onChange={(event) => {
                setDraft(event.target.value)
                setError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void submit(true)
                }
              }}
            />
            {error ? (
              <div role="alert" className="space-y-1">
                <p className="text-xs break-words text-destructive">{error}</p>
                {rejectedOnVerify ? (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    disabled={!canSubmit}
                    onClick={() => void submit(false)}
                  >
                    {translate(
                      'auto.components.settings.CloudSpeechProviderKeyDialog.saveUnverified',
                      'Save without checking'
                    )}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
            <Lock className="size-3 shrink-0" />
            {translate(
              'auto.components.settings.OpenAiTranscriptionKeyDialog.d246b2bdb3',
              'Local runtime keys are stored in ~/.orca using Electron encrypted storage when available.'
            )}
          </p>
        </div>
        <DialogFooter>
          <Button disabled={!canSubmit} onClick={() => void submit(true)} className="min-w-28">
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {busy && verifying
              ? translate(
                  'auto.components.settings.CloudSpeechProviderKeyDialog.checking',
                  'Checking…'
                )
              : translate(
                  'auto.components.settings.CloudSpeechProviderKeyDialog.verifyAndSave',
                  'Check and save'
                )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
