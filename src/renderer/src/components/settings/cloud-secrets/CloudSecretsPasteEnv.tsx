import { useId, useMemo, useState } from 'react'
import { AlertCircle, CircleCheck, Loader2, X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import {
  cloudSecretKind,
  cloudSecretNameError,
  cloudSecretValueError
} from '../../../../../shared/cloud-secrets/cloud-secret-rules'
import {
  MAX_CLOUD_SECRET_BATCH,
  cloudSecretsErrorCode,
  type CloudSecretBatchResult,
  type CloudSecretsErrorCode
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import {
  parseDotenvPaste,
  type DotenvPasteIssue
} from '../../../../../shared/cloud-secrets/dotenv-paste'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Textarea } from '../../ui/textarea'
import { cloudSecretKindLabel, cloudSecretsErrorCopy } from './cloud-secrets-copy'
import { isOwnKeyEvent } from './CloudSecretEditor'
import { SecretValueInput } from './SecretValueInput'

type PasteRow = {
  /** Paste number and line: unique across several pastes. */
  id: string
  line: number
  name: string
  value: string
  /** A problem only the parser can see (an unreadable line, a missing closing quote). */
  parseIssue: DotenvPasteIssue | null
  serverError: CloudSecretsErrorCode | null
}

function toRows(text: string, paste: number): PasteRow[] {
  return parseDotenvPaste(text).map((entry) => ({
    id: `${paste}:${entry.line}`,
    line: entry.line,
    name: entry.name,
    value: entry.value,
    parseIssue: entry.issue,
    serverError: null
  }))
}

function rowIssue(row: PasteRow, overridden: boolean): DotenvPasteIssue | null {
  return (
    row.serverError ??
    (row.parseIssue && row.parseIssue !== 'overridden' ? row.parseIssue : null) ??
    cloudSecretNameError(row.name) ??
    cloudSecretValueError(row.name, row.value) ??
    (overridden ? 'overridden' : null)
  )
}

function RowEditor({
  row,
  issue,
  replaces,
  onChange,
  onRemove
}: {
  row: PasteRow
  issue: DotenvPasteIssue | null
  replaces: boolean
  onChange: (patch: Partial<PasteRow>) => void
  onRemove: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const blocking = issue !== null && issue !== 'overridden'
  return (
    <li className="space-y-1 px-3 py-2">
      <div className="flex items-center gap-2">
        {blocking ? (
          <AlertCircle aria-hidden className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <CircleCheck aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <Input
          id={`${id}-name`}
          variant="code"
          density="compact"
          value={row.name}
          onChange={(event) =>
            onChange({
              name: event.target.value.toUpperCase(),
              parseIssue: null,
              serverError: null
            })
          }
          aria-label={t('cloudSecrets.paste.nameLabel', 'Name, line {{line}}', {
            line: String(row.line)
          })}
          aria-invalid={blocking || undefined}
          aria-describedby={issue ? `${id}-issue` : undefined}
          spellCheck={false}
          autoComplete="off"
          className="w-56 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <SecretValueInput
            id={`${id}-value`}
            value={row.value}
            onChange={(value) => onChange({ value, parseIssue: null, serverError: null })}
            invalid={blocking}
            describedBy={issue ? `${id}-issue` : undefined}
          />
        </div>
        {row.name && cloudSecretKind(row.name) === 'agent_key' ? (
          <Badge variant="referenceLabel">{cloudSecretKindLabel(row.name, t)}</Badge>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onRemove}
          aria-label={t('cloudSecrets.paste.remove', 'Leave out {{name}}', {
            name: row.name || String(row.line)
          })}
        >
          <X />
        </Button>
      </div>
      <p
        id={`${id}-issue`}
        className={
          blocking ? 'pl-5.5 text-2xs text-destructive' : 'pl-5.5 text-2xs text-muted-foreground'
        }
      >
        {issue
          ? cloudSecretsErrorCopy(issue, t)
          : replaces
            ? t('cloudSecrets.paste.replaces', 'Replaces the saved value')
            : t('cloudSecrets.paste.adds', 'New')}
      </p>
    </li>
  )
}

/**
 * Paste a .env file: it is read into rows at once (names visible, values masked) and the raw text is
 * dropped, so the file is never left on screen or in reach of a screen reader. Clean rows save in one batch.
 */
export function CloudSecretsPasteEnv({
  existingNames,
  onSave,
  onCancel,
  initialText = ''
}: {
  existingNames: readonly string[]
  onSave: (set: Record<string, string>) => Promise<CloudSecretBatchResult | CloudSecretsErrorCode>
  onCancel: () => void
  /** Fixtures only: as if this text had been pasted. */
  initialText?: string
}): React.JSX.Element {
  const t = useTranslate()
  const formId = useId()
  const [rows, setRows] = useState<PasteRow[]>(() => (initialText ? toRows(initialText, 0) : []))
  const [pastes, setPastes] = useState(1)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<CloudSecretsErrorCode | null>(null)
  const existing = useMemo(() => new Set(existingNames), [existingNames])

  const issues = useMemo(() => {
    const lastIndex = new Map(rows.map((row, index) => [row.name, index]))
    return rows.map((row, index) => rowIssue(row, lastIndex.get(row.name) !== index))
  }, [rows])
  const batch: Record<string, string> = {}
  rows.forEach((row, index) => {
    if (issues[index] === null) {
      batch[row.name] = row.value
    }
  })
  const count = Object.keys(batch).length
  const blocked = issues.filter((issue) => issue !== null && issue !== 'overridden').length
  const duplicates = issues.filter((issue) => issue === 'overridden').length
  const tooMany = count > MAX_CLOUD_SECRET_BATCH
  // Rows that need a fix first, so they can be checked without scrolling.
  const order = rows
    .map((row, index) => ({ row, issue: issues[index] }))
    .sort(
      (a, b) =>
        Number(a.issue === null || a.issue === 'overridden') -
        Number(b.issue === null || b.issue === 'overridden')
    )

  const update = (id: string, patch: Partial<PasteRow>): void => {
    setFailure(null)
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

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
    // Saved values leave the form at once; only rows that still need attention stay.
    setRows((current) =>
      current.flatMap((row, index) =>
        errors.has(row.name)
          ? [{ ...row, serverError: errors.get(row.name) ?? null }]
          : issues[index] !== null && issues[index] !== 'overridden'
            ? [row]
            : []
      )
    )
  }

  const summary = failure
    ? cloudSecretsErrorCopy(failure, t)
    : tooMany
      ? t('cloudSecrets.paste.tooMany', 'Paste at most {{max}} variables at a time.', {
          max: String(MAX_CLOUD_SECRET_BATCH)
        })
      : rows.length === 0
        ? null
        : [
            t('cloudSecrets.paste.ready', '{{count}} ready', { count }),
            blocked > 0
              ? t('cloudSecrets.paste.blocked', '{{blocked}} need a fix and will be skipped', {
                  blocked: String(blocked)
                })
              : null,
            duplicates > 0
              ? t('cloudSecrets.paste.duplicates', '{{duplicates}} duplicate ignored', {
                  duplicates: String(duplicates)
                })
              : null
          ]
            .filter(Boolean)
            .join(' · ')

  return (
    <div
      className="space-y-3 rounded-lg border border-border bg-background/60 p-3"
      onKeyDown={(event) => {
        // Rows already read are not thrown away by a stray Escape; Cancel still discards them.
        if (event.key === 'Escape' && !saving && rows.length === 0 && isOwnKeyEvent(event)) {
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor={`${formId}-text`} variant="settings">
          {t('cloudSecrets.paste.label', 'Paste a .env file')}
        </Label>
        <Textarea
          id={`${formId}-text`}
          value=""
          autoFocus
          // Paste-only: the text becomes rows below and never stays in this field.
          onChange={() => undefined}
          onPaste={(event) => {
            event.preventDefault()
            const pasted = toRows(event.clipboardData.getData('text'), pastes)
            setPastes(pastes + 1)
            if (pasted.length > 0) {
              setFailure(null)
              setRows((current) => [...current, ...pasted])
            }
          }}
          placeholder={t(
            'cloudSecrets.paste.placeholder',
            'Paste here. Comments, blank lines, export and quoted or multi-line values are understood.'
          )}
          variant="code"
          className="min-h-16"
          aria-describedby={`${formId}-summary`}
        />
      </div>

      {rows.length > 0 ? (
        <ul
          aria-label={t('cloudSecrets.paste.preview', 'Variables to save')}
          className="max-h-80 divide-y divide-border/60 overflow-y-auto rounded-md border border-border/60 scrollbar-sleek"
        >
          {order.map(({ row, issue }) => (
            <RowEditor
              key={row.id}
              row={row}
              issue={issue}
              replaces={existing.has(row.name)}
              onChange={(patch) => update(row.id, patch)}
              onRemove={() => setRows((current) => current.filter((entry) => entry.id !== row.id))}
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
          {summary}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => !saving && onCancel()}>
            {t('cloudSecrets.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={count === 0 || tooMany}
            aria-disabled={saving || undefined}
            aria-busy={saving || undefined}
            onClick={() => void save()}
          >
            {saving ? <Loader2 className="animate-spin" /> : null}
            {count === 1
              ? t('cloudSecrets.paste.saveOne', 'Save 1 secret')
              : t('cloudSecrets.paste.saveMany', 'Save {{count}} secrets', { count })}
          </Button>
        </div>
      </div>
    </div>
  )
}
