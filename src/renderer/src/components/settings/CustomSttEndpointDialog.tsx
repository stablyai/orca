import { Loader2, Server, Wifi } from 'lucide-react'
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

type CustomSttEndpointDialogProps = {
  open: boolean
  configured: boolean
  baseUrlDraft: string
  modelDraft: string
  languageDraft: string
  apiKeyDraft: string
  apiKeyConfigured: boolean
  pending: boolean
  testing: boolean
  testResult: { ok: boolean; detail: string } | null
  onOpenChange: (open: boolean) => void
  onBaseUrlDraftChange: (value: string) => void
  onModelDraftChange: (value: string) => void
  onLanguageDraftChange: (value: string) => void
  onApiKeyDraftChange: (value: string) => void
  onSave: () => void
  onClear: () => void
  onTest: () => void
}

export function CustomSttEndpointDialog({
  open,
  configured,
  baseUrlDraft,
  modelDraft,
  languageDraft,
  apiKeyDraft,
  apiKeyConfigured,
  pending,
  testing,
  testResult,
  onOpenChange,
  onBaseUrlDraftChange,
  onModelDraftChange,
  onLanguageDraftChange,
  onApiKeyDraftChange,
  onSave,
  onClear,
  onTest
}: CustomSttEndpointDialogProps): React.JSX.Element {
  const canSave = baseUrlDraft.trim() !== '' && modelDraft.trim() !== ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.CustomSttEndpointDialog.title',
              'Custom transcription endpoint'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.CustomSttEndpointDialog.description',
              'Audio is sent to this server only when the Custom endpoint model is selected.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="custom-stt-base-url">
              {translate('auto.components.settings.CustomSttEndpointDialog.baseUrl', 'Base URL')}
            </Label>
            <Input
              id="custom-stt-base-url"
              value={baseUrlDraft}
              placeholder="http://127.0.0.1:8090/v1"
              disabled={pending}
              onChange={(event) => onBaseUrlDraftChange(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="custom-stt-model">
              {translate('auto.components.settings.CustomSttEndpointDialog.model', 'Model')}
            </Label>
            <Input
              id="custom-stt-model"
              value={modelDraft}
              placeholder="large-v3"
              disabled={pending}
              onChange={(event) => onModelDraftChange(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="custom-stt-language">
              {translate(
                'auto.components.settings.CustomSttEndpointDialog.language',
                'Language (optional)'
              )}
            </Label>
            <Input
              id="custom-stt-language"
              value={languageDraft}
              placeholder={translate(
                'auto.components.settings.CustomSttEndpointDialog.languagePlaceholder',
                'Auto-detect (e.g. en, zh, yue)'
              )}
              disabled={pending}
              onChange={(event) => onLanguageDraftChange(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="custom-stt-api-key">
              {translate(
                'auto.components.settings.CustomSttEndpointDialog.apiKey',
                'API Key (optional)'
              )}
            </Label>
            <Input
              id="custom-stt-api-key"
              type="password"
              value={apiKeyDraft}
              placeholder={
                apiKeyConfigured
                  ? translate(
                      'auto.components.settings.CustomSttEndpointDialog.apiKeyConfigured',
                      'Token configured'
                    )
                  : translate(
                      'auto.components.settings.CustomSttEndpointDialog.apiKeyOptional',
                      'Leave empty for self-hosted servers'
                    )
              }
              disabled={pending}
              onChange={(event) => onApiKeyDraftChange(event.target.value)}
            />
          </div>
        </div>
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
          <Server className="size-3 shrink-0" />
          {translate(
            'auto.components.settings.CustomSttEndpointDialog.hint',
            'Works with any OpenAI-compatible /audio/transcriptions server, e.g. a local worker on 127.0.0.1.'
          )}
        </p>
        {testResult && (
          <p
            className={`flex items-center gap-1.5 text-[11px] ${
              testResult.ok ? 'text-status-success' : 'text-destructive'
            }`}
          >
            <Wifi className="size-3 shrink-0" />
            {testResult.detail}
          </p>
        )}
        <DialogFooter>
          {configured && (
            <Button variant="outline" disabled={pending} onClick={onClear}>
              {translate('auto.components.settings.CustomSttEndpointDialog.clear', 'Disconnect')}
            </Button>
          )}
          <Button variant="outline" disabled={pending || testing || !canSave} onClick={onTest}>
            {testing ? <Loader2 className="size-4 animate-spin" /> : null}
            {translate('auto.components.settings.CustomSttEndpointDialog.test', 'Test')}
          </Button>
          <Button disabled={pending || !canSave} onClick={onSave}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {translate('auto.components.settings.CustomSttEndpointDialog.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
