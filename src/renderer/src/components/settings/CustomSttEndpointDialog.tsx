import { useState } from 'react'
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
import { filterSpeechLanguageOptions } from '../../../../shared/speech-language-options'
import type { CustomSttEndpointTestOutcome } from '../../../../shared/speech-types'
import { translate } from '@/i18n/i18n'

export type CustomSttEndpointTestState = {
  ok: boolean
  outcome: CustomSttEndpointTestOutcome
  detail: string
}

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
  testResult: CustomSttEndpointTestState | null
  onOpenChange: (open: boolean) => void
  onBaseUrlDraftChange: (value: string) => void
  onModelDraftChange: (value: string) => void
  onLanguageDraftChange: (value: string) => void
  onApiKeyDraftChange: (value: string) => void
  onSave: (options?: { allowInvalid?: boolean }) => void
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
  // Why: a server rejection or a local format error means saving is pointless; a
  // transport failure may just be an offline server, so it must not block saving.
  const blocked = testResult?.outcome === 'rejected' || testResult?.outcome === 'invalid'

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
          <LanguageCombobox
            value={languageDraft}
            disabled={pending}
            onChange={onLanguageDraftChange}
          />
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
              testResult.ok
                ? 'text-status-success'
                : testResult.outcome === 'transport' || testResult.outcome === 'auth'
                  ? 'text-status-warning'
                  : 'text-destructive'
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
          <Button disabled={pending || !canSave || blocked} onClick={() => onSave()}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {translate('auto.components.settings.CustomSttEndpointDialog.save', 'Save')}
          </Button>
        </DialogFooter>
        {blocked && (
          <button
            type="button"
            disabled={pending}
            onClick={() => onSave({ allowInvalid: true })}
            className="self-center text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
          >
            {translate(
              'auto.components.settings.CustomSttEndpointDialog.saveAnyway',
              'Save anyway (advanced)'
            )}
          </button>
        )}
      </DialogContent>
    </Dialog>
  )
}

type LanguageComboboxProps = {
  value: string
  disabled: boolean
  onChange: (value: string) => void
}

/**
 * Free-text language field with a suggestion list. Deliberately not a fixed
 * dropdown: the accepted code set is server/model specific, and a strict
 * ISO-639-1 list would exclude valid three-letter codes such as `yue`.
 */
function LanguageCombobox({ value, disabled, onChange }: LanguageComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const suggestions = filterSpeechLanguageOptions(value)

  return (
    <div className="space-y-2">
      <Label htmlFor="custom-stt-language">
        {translate(
          'auto.components.settings.CustomSttEndpointDialog.language',
          'Language (optional)'
        )}
      </Label>
      <div className="relative">
        <Input
          id="custom-stt-language"
          value={value}
          autoComplete="off"
          placeholder={translate(
            'auto.components.settings.CustomSttEndpointDialog.languagePlaceholder',
            'Auto-detect (e.g. en, zh, yue)'
          )}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Why: delay so a click on a suggestion lands before the list unmounts.
            setTimeout(() => setOpen(false), 120)
          }}
        />
        {open && suggestions.length > 0 && (
          <div className="absolute z-50 mt-1 max-h-52 w-full overflow-y-auto scrollbar-sleek rounded-md border border-border bg-popover p-1 shadow-md">
            {suggestions.map((option) => (
              <button
                key={option.value || 'auto'}
                type="button"
                // Why: mousedown fires before the input's blur, so the pick is not lost.
                onMouseDown={(event) => {
                  event.preventDefault()
                  onChange(option.value)
                  setOpen(false)
                }}
                className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <span>{option.label}</span>
                {option.value && (
                  <span className="text-[11px] text-muted-foreground">{option.value}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground/70">
        {translate(
          'auto.components.settings.CustomSttEndpointDialog.languageHint',
          'Suggestions are examples — enter any code your server accepts. Leave empty to auto-detect.'
        )}
      </p>
    </div>
  )
}
