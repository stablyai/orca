import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import {
  MAX_CLOUD_SECRET_BATCH,
  cloudSecretsErrorCode,
  type CloudSecretBatchResult,
  type CloudSecretsErrorCode
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
import { Textarea } from '../../ui/textarea'
import { cloudSecretsErrorCopy } from './cloud-secrets-copy'
import { isOwnKeyEvent } from './CloudSecretEditor'
import {
  PasteRowEditor,
  isUnreadable,
  rowIssue,
  toRows,
  type PasteRow
} from './CloudSecretsPasteRow'

// The summary is announced once a burst of pastes and edits settles, not on every keystroke.
const ANNOUNCE_DELAY_MS = 700

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
  const listRef = useRef<HTMLUListElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)

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
  const skipped = rows.filter(isUnreadable).length
  const blocked =
    issues.filter((issue) => issue !== null && issue !== 'overridden').length - skipped
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

  // A row that leaves the list takes focus with it; land on the given row's first control instead.
  // 'fix' is the first editable row, which is the first one needing a fix since those sort first.
  // Applied after the commit that removes the row, so the target is read from the new list.
  const pendingFocus = useRef<string | null | undefined>(undefined)
  const focusRow = (id: string | null): void => {
    pendingFocus.current = id
  }
  useEffect(() => {
    const id = pendingFocus.current
    if (id === undefined) {
      return
    }
    pendingFocus.current = undefined
    const list = listRef.current
    const target =
      id === 'fix'
        ? list?.querySelector<HTMLElement>('[data-paste-row] input')
        : id
          ? list
              ?.querySelector(`[data-paste-row="${id}"]`)
              ?.querySelector<HTMLElement>('input, button')
          : null
    ;(target ?? textRef.current)?.focus()
  }, [rows])

  const remove = (id: string): void => {
    const at = order.findIndex(({ row }) => row.id === id)
    const next = order[at + 1] ?? order[at - 1]
    setRows((current) => current.filter((entry) => entry.id !== id))
    focusRow(next ? next.row.id : null)
  }

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
    // Rows this save settles, as they were when sent: the sent row carries any server error, and a
    // duplicate it overrode leaves with it either way.
    const settled = new Map(
      rows.flatMap((row, index) =>
        issues[index] === null || issues[index] === 'overridden'
          ? [[row.id, { as: `${row.name}=${row.value}`, sent: issues[index] === null }] as const]
          : []
      )
    )
    const result = await onSave(batch)
    setSaving(false)
    if (typeof result === 'string') {
      setFailure(result)
      return
    }
    const errors = new Map(
      result.errors.map((entry) => [entry.name, cloudSecretsErrorCode(entry.reason)])
    )
    // Saved values leave the form at once. Rows that still need attention stay, and so does anything
    // pasted or edited while the request was out.
    setRows((current) =>
      current.flatMap((row) => {
        const sent = settled.get(row.id)
        if (sent === undefined || sent.as !== `${row.name}=${row.value}`) {
          return [row]
        }
        const error = sent.sent ? errors.get(row.name) : undefined
        return error ? [{ ...row, serverError: error }] : []
      })
    )
    if (errors.size > 0) {
      focusRow('fix')
    }
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
              ? t('cloudSecrets.paste.blocked', '{{count}} need a fix and will be skipped', {
                  count: blocked,
                  defaultValue_one: '{{count}} needs a fix and will be skipped'
                })
              : null,
            skipped > 0
              ? t('cloudSecrets.paste.unreadable', '{{count}} unreadable lines skipped', {
                  count: skipped,
                  defaultValue_one: '{{count}} unreadable line skipped'
                })
              : null,
            duplicates > 0
              ? t('cloudSecrets.paste.duplicates', '{{count}} duplicates ignored', {
                  count: duplicates,
                  defaultValue_one: '{{count}} duplicate ignored'
                })
              : null
          ]
            .filter(Boolean)
            .join(' · ')

  // Shown at once, announced once it settles: a fast edit or a run of pastes is read out one time.
  const [announced, setAnnounced] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(
      () => setAnnounced(summary ?? ''),
      failure ? 0 : ANNOUNCE_DELAY_MS
    )
    return () => window.clearTimeout(timer)
  }, [summary, failure])

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
          ref={textRef}
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
          aria-describedby={`${formId}-hint ${formId}-summary`}
        />
        <p id={`${formId}-hint`} className="text-2xs text-muted-foreground">
          {t(
            'cloudSecrets.paste.pasteOnly',
            'Paste only: typing here does nothing. Edit names and values in the rows below.'
          )}
        </p>
      </div>

      {rows.length > 0 ? (
        <ul
          ref={listRef}
          aria-label={t('cloudSecrets.paste.preview', 'Variables to save')}
          className="max-h-80 divide-y divide-border/60 overflow-y-auto rounded-md border border-border/60 scrollbar-sleek"
        >
          {order.map(({ row, issue }) => (
            <PasteRowEditor
              key={row.id}
              row={row}
              issue={issue}
              replaces={existing.has(row.name)}
              onChange={(patch) => update(row.id, patch)}
              onRemove={() => remove(row.id)}
            />
          ))}
        </ul>
      ) : null}

      <div className="flex items-start justify-between gap-3">
        <p role="status" className="sr-only">
          {announced}
        </p>
        <p
          id={`${formId}-summary`}
          className={
            failure || tooMany
              ? 'min-w-0 text-xs text-destructive'
              : 'min-w-0 text-xs text-muted-foreground'
          }
        >
          {/* Counts wrap between segments, never between a number and its noun. */}
          {failure || tooMany
            ? summary
            : summary?.split(' · ').map((part, index) => (
                <Fragment key={part}>
                  {index > 0 ? ' · ' : ''}
                  <span className="whitespace-nowrap">{part}</span>
                </Fragment>
              ))}
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
            {t('cloudSecrets.paste.save', 'Save {{count}} secrets', {
              count,
              defaultValue_one: 'Save {{count}} secret'
            })}
          </Button>
        </div>
      </div>
    </div>
  )
}
