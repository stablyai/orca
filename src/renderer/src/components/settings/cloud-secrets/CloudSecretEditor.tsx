import { useId, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import {
  cloudSecretNameError,
  cloudSecretValueError
} from '../../../../../shared/cloud-secrets/cloud-secret-rules'
import type { CloudSecretsErrorCode } from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { cloudSecretsErrorCopy } from './cloud-secrets-copy'
import { SecretValueInput } from './SecretValueInput'

export type CloudSecretEditorTarget =
  | { kind: 'add' }
  | { kind: 'replace'; name: string; hint: string | null }

/** Add a secret or replace one's value. The typed value lives only in this form until it is sent. */
export function CloudSecretEditor({
  target,
  onSave,
  onCancel,
  initialError = null
}: {
  target: CloudSecretEditorTarget
  onSave: (name: string, value: string) => Promise<CloudSecretsErrorCode | null>
  onCancel: () => void
  /** Fixtures only. */
  initialError?: CloudSecretsErrorCode | null
}): React.JSX.Element {
  const t = useTranslate()
  const formId = useId()
  const [name, setName] = useState(target.kind === 'replace' ? target.name : '')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<CloudSecretsErrorCode | null>(initialError)
  const errorIsName = error !== null && error === cloudSecretNameError(name)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (saving) {
      return
    }
    const local = cloudSecretNameError(name) ?? cloudSecretValueError(name, value)
    if (local) {
      setError(local)
      return
    }
    setSaving(true)
    const failure = await onSave(name, value)
    setSaving(false)
    if (failure) {
      setError(failure)
    } else {
      setValue('')
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) {
          event.stopPropagation()
          onCancel()
        }
      }}
      className="space-y-3 rounded-lg border border-border bg-background/60 p-3"
      aria-label={
        target.kind === 'add'
          ? t('cloudSecrets.editor.addLabel', 'Add a secret')
          : t('cloudSecrets.editor.replaceLabel', 'Replace {{name}}', { name: target.name })
      }
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <div className="space-y-1.5">
          <Label htmlFor={`${formId}-name`} variant="settings">
            {t('cloudSecrets.editor.name', 'Name')}
          </Label>
          <Input
            id={`${formId}-name`}
            variant="code"
            value={name}
            disabled={target.kind === 'replace'}
            autoFocus={target.kind === 'add'}
            onChange={(event) => {
              setName(event.target.value.toUpperCase().replace(/[\s-]/g, '_'))
              setError(null)
            }}
            placeholder="DATABASE_URL"
            aria-invalid={errorIsName || undefined}
            spellCheck={false}
            autoComplete="off"
            className="h-8"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${formId}-value`} variant="settings">
            {target.kind === 'replace'
              ? t('cloudSecrets.editor.newValue', 'New value')
              : t('cloudSecrets.editor.value', 'Value')}
          </Label>
          <SecretValueInput
            id={`${formId}-value`}
            value={value}
            onChange={(next) => {
              setValue(next)
              setError(null)
            }}
            autoFocus={target.kind === 'replace'}
            invalid={error !== null && !errorIsName}
            describedBy={`${formId}-status`}
            placeholder={
              target.kind === 'replace' && target.hint
                ? t('cloudSecrets.editor.replacePlaceholder', 'Replaces ••••{{hint}}', {
                    hint: target.hint
                  })
                : undefined
            }
          />
        </div>
      </div>
      <div className="flex items-start justify-between gap-3">
        <p id={`${formId}-status`} role="alert" className="min-h-4 text-xs text-destructive">
          {error ? cloudSecretsErrorCopy(error, t) : null}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            {t('cloudSecrets.cancel', 'Cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={saving || !name || !value}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            {target.kind === 'replace'
              ? t('cloudSecrets.editor.replace', 'Replace')
              : t('cloudSecrets.editor.save', 'Save')}
          </Button>
        </div>
      </div>
    </form>
  )
}
