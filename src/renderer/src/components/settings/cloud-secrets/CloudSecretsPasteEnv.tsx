import { useId, useMemo, useState } from 'react'
import { AlertCircle, CircleCheck, Eye, EyeOff, Loader2, RefreshCcw } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import {
  MAX_CLOUD_SECRET_BATCH,
  cloudSecretsErrorCode,
  type CloudSecretBatchResult,
  type CloudSecretsErrorCode
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import {
  dotenvPasteToBatch,
  parseDotenvPaste,
  type DotenvPasteEntry
} from '../../../../../shared/cloud-secrets/dotenv-paste'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
import { Textarea } from '../../ui/textarea'
import { cn } from '@/lib/utils'
import { cloudSecretKindLabel, cloudSecretsErrorCopy } from './cloud-secrets-copy'

function PreviewLine({
  entry,
  replaces,
  serverError
}: {
  entry: DotenvPasteEntry
  replaces: boolean
  serverError: CloudSecretsErrorCode | null
}): React.JSX.Element {
  const t = useTranslate()
  const issue = serverError ?? entry.issue
  const skipped = entry.issue === 'overridden'
  return (
    <li className="flex items-start gap-2.5 px-3 py-1.5 text-xs">
      <span className="w-8 shrink-0 text-right font-mono text-muted-foreground tabular-nums">
        {entry.line}
      </span>
      {issue && !skipped ? (
        <AlertCircle aria-hidden className="mt-px size-3.5 shrink-0 text-destructive" />
      ) : (
        <CircleCheck aria-hidden className="mt-px size-3.5 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <code className="truncate font-mono">
            {entry.name || t('cloudSecrets.paste.unreadable', 'Unreadable line')}
          </code>
          {entry.kind === 'agent_key' && entry.name ? (
            <Badge variant="referenceLabel">{cloudSecretKindLabel(entry.name, t)}</Badge>
          ) : null}
        </div>
        {issue ? (
          <p className={skipped ? 'text-muted-foreground' : 'text-destructive'}>
            {cloudSecretsErrorCopy(issue, t)}
          </p>
        ) : null}
      </div>
      {!issue ? (
        <span className="shrink-0 text-muted-foreground">
          {replaces
            ? t('cloudSecrets.paste.replaces', 'Replaces saved value')
            : t('cloudSecrets.paste.adds', 'New')}
        </span>
      ) : null}
    </li>
  )
}

/** Paste a .env file, check every line, then save the clean ones in one batch. */
export function CloudSecretsPasteEnv({
  existingNames,
  onSave,
  onCancel,
  initialText = ''
}: {
  existingNames: readonly string[]
  onSave: (set: Record<string, string>) => Promise<CloudSecretBatchResult | CloudSecretsErrorCode>
  onCancel: () => void
  /** Fixtures only. */
  initialText?: string
}): React.JSX.Element {
  const t = useTranslate()
  const formId = useId()
  const [text, setText] = useState(initialText)
  const [revealed, setRevealed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<CloudSecretsErrorCode | null>(null)
  const [serverErrors, setServerErrors] = useState<ReadonlyMap<string, CloudSecretsErrorCode>>(
    new Map()
  )
  const entries = useMemo(() => parseDotenvPaste(text), [text])
  const batch = useMemo(() => dotenvPasteToBatch(entries), [entries])
  const count = Object.keys(batch).length
  const blocked = entries.filter((entry) => entry.issue && entry.issue !== 'overridden').length
  const duplicates = entries.filter((entry) => entry.issue === 'overridden').length
  const existing = useMemo(() => new Set(existingNames), [existingNames])
  const tooMany = count > MAX_CLOUD_SECRET_BATCH

  const save = async (): Promise<void> => {
    if (saving || count === 0 || tooMany) {
      return
    }
    setSaving(true)
    setFailure(null)
    const result = await onSave(batch)
    setSaving(false)
    if (typeof result === 'string') {
      setFailure(result)
      return
    }
    const errors = new Map(
      result.errors.map((entry) => [entry.name, cloudSecretsErrorCode(entry.reason)])
    )
    setServerErrors(errors)
    // Keep only the lines that still need attention; saved values leave the form at once.
    setText(
      entries
        .filter(
          (entry) =>
            errors.has(entry.name) || (entry.issue !== null && entry.issue !== 'overridden')
        )
        .map((entry) => entry.raw)
        .join('\n')
    )
  }

  return (
    <div
      className="space-y-3 rounded-lg border border-border bg-background/60 p-3"
      onKeyDown={(event) => {
        // A big paste is not thrown away by a stray Escape; Cancel still discards it.
        if (event.key === 'Escape' && !saving && text.trim() === '') {
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`${formId}-text`} variant="settings">
            {t('cloudSecrets.paste.label', 'Paste a .env file')}
          </Label>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-pressed={revealed}
            onClick={() => setRevealed((shown) => !shown)}
          >
            {revealed ? <EyeOff /> : <Eye />}
            {revealed
              ? t('cloudSecrets.paste.hide', 'Hide values')
              : t('cloudSecrets.paste.show', 'Show values')}
          </Button>
        </div>
        <Textarea
          id={`${formId}-text`}
          value={text}
          autoFocus
          onChange={(event) => {
            setText(event.target.value)
            setServerErrors(new Map())
            setFailure(null)
          }}
          placeholder={
            '# Comments and blank lines are ignored\nDATABASE_URL=postgres://…\nexport STRIPE_KEY="sk_test_…"'
          }
          spellCheck={false}
          autoComplete="off"
          data-1p-ignore=""
          variant="code"
          className={cn('min-h-28', !revealed && '[-webkit-text-security:disc]')}
          aria-describedby={`${formId}-summary`}
        />
        <p className="text-2xs text-muted-foreground">
          {t(
            'cloudSecrets.paste.masked',
            'Values stay masked here and are hidden once saved. Quotes, export and multi-line values work.'
          )}
        </p>
      </div>

      {entries.length > 0 ? (
        <ul
          aria-label={t('cloudSecrets.paste.preview', 'Preview')}
          className="max-h-64 divide-y divide-border/60 overflow-y-auto rounded-md border border-border/60 scrollbar-sleek"
        >
          {entries.map((entry) => (
            <PreviewLine
              key={`${entry.line}:${entry.name}`}
              entry={entry}
              replaces={existing.has(entry.name)}
              serverError={serverErrors.get(entry.name) ?? null}
            />
          ))}
        </ul>
      ) : null}

      <div className="flex items-start justify-between gap-3">
        <p
          id={`${formId}-summary`}
          role="status"
          className={
            failure || tooMany ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
          }
        >
          {failure
            ? cloudSecretsErrorCopy(failure, t)
            : tooMany
              ? t('cloudSecrets.paste.tooMany', 'Paste at most {{max}} variables at a time.', {
                  max: String(MAX_CLOUD_SECRET_BATCH)
                })
              : serverErrors.size > 0
                ? t(
                    'cloudSecrets.paste.partial',
                    'Saved the rest. Fix the lines above and save again.'
                  )
                : entries.length === 0
                  ? null
                  : [
                      t('cloudSecrets.paste.ready', '{{count}} ready', { count }),
                      blocked > 0
                        ? t(
                            'cloudSecrets.paste.blocked',
                            '{{blocked}} need a fix and will be skipped',
                            {
                              blocked: String(blocked)
                            }
                          )
                        : null,
                      duplicates > 0
                        ? t('cloudSecrets.paste.duplicates', '{{duplicates}} duplicate ignored', {
                            duplicates: String(duplicates)
                          })
                        : null
                    ]
                      .filter(Boolean)
                      .join(' · ')}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            {t('cloudSecrets.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving || count === 0 || tooMany}
            onClick={() => void save()}
          >
            {saving ? (
              <Loader2 className="animate-spin" />
            ) : serverErrors.size > 0 ? (
              <RefreshCcw />
            ) : null}
            {count === 1
              ? t('cloudSecrets.paste.saveOne', 'Save 1 secret')
              : t('cloudSecrets.paste.saveMany', 'Save {{count}} secrets', {
                  count
                })}
          </Button>
        </div>
      </div>
    </div>
  )
}
