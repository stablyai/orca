import { useState } from 'react'
import { CheckCircle2, Loader2, Server, Wifi, XCircle } from 'lucide-react'
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
import type {
  CustomSttEndpointReachability,
  CustomSttEndpointTestOutcome
} from '../../../../shared/speech-types'
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
  modelSuggestions: string[]
  discovering: boolean
  languageDraft: string
  apiKeyDraft: string
  apiKeyConfigured: boolean
  pending: boolean
  testing: boolean
  reachability: CustomSttEndpointReachability
  testResult: CustomSttEndpointTestState | null
  onOpenChange: (open: boolean) => void
  onBaseUrlDraftChange: (value: string) => void
  onModelDraftChange: (value: string) => void
  onLanguageDraftChange: (value: string) => void
  onApiKeyDraftChange: (value: string) => void
  onSave: (options?: { allowInvalid?: boolean }) => void
  onClear: () => void
  onTest: () => void
  onCancel: () => void
}

export function CustomSttEndpointDialog({
  open,
  configured,
  baseUrlDraft,
  modelDraft,
  modelSuggestions,
  discovering,
  languageDraft,
  apiKeyDraft,
  apiKeyConfigured,
  pending,
  testing,
  reachability,
  testResult,
  onOpenChange,
  onBaseUrlDraftChange,
  onModelDraftChange,
  onLanguageDraftChange,
  onApiKeyDraftChange,
  onSave,
  onClear,
  onTest,
  onCancel
}: CustomSttEndpointDialogProps): React.JSX.Element {
  const canSave = baseUrlDraft.trim() !== '' && modelDraft.trim() !== ''
  const canTest = baseUrlDraft.trim() !== ''
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
            <div className="flex items-center gap-2">
              <Input
                id="custom-stt-base-url"
                value={baseUrlDraft}
                placeholder="http://127.0.0.1:8090/v1"
                disabled={pending}
                onChange={(event) => onBaseUrlDraftChange(event.target.value)}
              />
              <EndpointStatusMark reachability={reachability} discovering={discovering} />
            </div>
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
          <SuggestionCombobox
            id="custom-stt-model"
            label={translate('auto.components.settings.CustomSttEndpointDialog.model', 'Model')}
            value={modelDraft}
            placeholder="large-v3"
            disabled={pending}
            loading={discovering}
            hint={
              modelSuggestions.length > 0
                ? translate(
                    'auto.components.settings.CustomSttEndpointDialog.modelHint',
                    'Suggested from this endpoint — type any model your server accepts.'
                  )
                : undefined
            }
            suggestions={modelSuggestions.map((id) => ({ value: id, label: id }))}
            onChange={onModelDraftChange}
          />
          <SuggestionCombobox
            id="custom-stt-language"
            label={translate(
              'auto.components.settings.CustomSttEndpointDialog.language',
              'Language (optional)'
            )}
            value={languageDraft}
            placeholder={translate(
              'auto.components.settings.CustomSttEndpointDialog.languagePlaceholder',
              'Auto-detect (e.g. en, zh, yue)'
            )}
            disabled={pending}
            suggestions={filterSpeechLanguageOptions('')}
            hint={translate(
              'auto.components.settings.CustomSttEndpointDialog.languageHint',
              'Suggestions are examples — enter any code your server accepts. Leave empty to auto-detect.'
            )}
            onChange={onLanguageDraftChange}
          />
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
          <Button variant="outline" disabled={pending || testing || !canTest} onClick={onTest}>
            {testing ? <Loader2 className="size-4 animate-spin" /> : null}
            {translate('auto.components.settings.CustomSttEndpointDialog.test', 'Test')}
          </Button>
          <Button variant="outline" disabled={pending} onClick={onCancel}>
            {translate('auto.components.settings.CustomSttEndpointDialog.cancel', 'Cancel')}
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

/**
 * A green tick when the URL answers, a red cross when it does not, and a spinner
 * while probing. Sits inside the Base URL field so the verdict is attached to the
 * value it is about.
 */
function EndpointStatusMark({
  reachability,
  discovering
}: {
  reachability: CustomSttEndpointReachability
  discovering: boolean
}): React.JSX.Element | null {
  if (discovering) {
    return (
      <Loader2
        aria-label={translate(
          'auto.components.settings.CustomSttEndpointDialog.checking',
          'Checking endpoint'
        )}
        className="size-4 shrink-0 animate-spin text-muted-foreground"
      />
    )
  }
  if (reachability === 'reachable') {
    return (
      <CheckCircle2
        aria-label={translate(
          'auto.components.settings.CustomSttEndpointDialog.reachable',
          'Endpoint reachable'
        )}
        className="size-4 shrink-0 text-status-success"
      />
    )
  }
  if (reachability === 'unreachable') {
    return (
      <XCircle
        aria-label={translate(
          'auto.components.settings.CustomSttEndpointDialog.unreachable',
          'Endpoint unreachable'
        )}
        className="size-4 shrink-0 text-destructive"
      />
    )
  }
  return null
}

/**
 * Free-text field with a suggestion list. Deliberately not a fixed dropdown: the
 * accepted set is server/model specific (and a strict ISO-639-1 list would exclude
 * valid three-letter codes such as `yue`), so the user can always type a value the
 * suggestions do not cover.
 */
type SuggestionComboboxProps = {
  id: string
  label: string
  value: string
  placeholder: string
  disabled: boolean
  suggestions: { value: string; label: string }[]
  onChange: (value: string) => void
  loading?: boolean
  hint?: string
}

function SuggestionCombobox({
  id,
  label,
  value,
  placeholder,
  disabled,
  suggestions,
  onChange,
  loading,
  hint
}: SuggestionComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const filtered = filterSuggestions(suggestions, value)

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          value={value}
          autoComplete="off"
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Why: delay so a click on a suggestion lands before the list unmounts.
            setTimeout(() => setOpen(false), 120)
          }}
        />
        {loading && (
          <Loader2 className="absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
        {open && filtered.length > 0 && (
          <div className="absolute z-50 mt-1 max-h-52 w-full overflow-y-auto scrollbar-sleek rounded-md border border-border bg-popover p-1 shadow-md">
            {filtered.map((option) => (
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
                {option.value && option.label !== option.value && (
                  <span className="text-[11px] text-muted-foreground">{option.value}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      {hint && <p className="text-[11px] text-muted-foreground/70">{hint}</p>}
    </div>
  )
}

function filterSuggestions(
  suggestions: { value: string; label: string }[],
  query: string
): { value: string; label: string }[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return suggestions
  }
  return suggestions.filter(
    (option) =>
      option.value.toLowerCase().includes(normalized) ||
      option.label.toLowerCase().includes(normalized)
  )
}
