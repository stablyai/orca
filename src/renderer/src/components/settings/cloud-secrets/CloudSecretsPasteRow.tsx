import { useId } from 'react'
import { AlertCircle, CircleCheck, X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import {
  cloudSecretKind,
  cloudSecretNameError,
  cloudSecretValueError
} from '../../../../../shared/cloud-secrets/cloud-secret-rules'
import type { CloudSecretsErrorCode } from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import {
  parseDotenvPaste,
  type DotenvPasteIssue
} from '../../../../../shared/cloud-secrets/dotenv-paste'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { cloudSecretKindLabel, cloudSecretsErrorCopy } from './cloud-secrets-copy'
import { SecretValueInput } from './SecretValueInput'

export type PasteRow = {
  /** Paste number and line: unique across several pastes. */
  id: string
  line: number
  name: string
  value: string
  /** A problem only the parser can see (an unreadable line, a missing closing quote). */
  parseIssue: DotenvPasteIssue | null
  serverError: CloudSecretsErrorCode | null
  /** The name as pasted, when it was rewritten to capitals and underscores. */
  renamedFrom: string | null
  /** A typed space or dash just became an underscore. */
  typedNormalized: boolean
}

/** `my-api key` -> `MY_API_KEY`: the form names take, so a near-miss paste needs no retyping. */
export function normalizeSecretName(name: string): string {
  return name.toUpperCase().replace(/[\s-]/g, '_')
}

export function toRows(text: string, paste: number): PasteRow[] {
  return parseDotenvPaste(text).map((entry) => {
    const name = normalizeSecretName(entry.name)
    return {
      id: `${paste}:${entry.line}`,
      line: entry.line,
      name,
      value: entry.value,
      // Name and value problems are re-checked against the rewritten name in rowIssue.
      parseIssue:
        entry.issue === 'syntax' || entry.issue === 'unterminated_quote' ? entry.issue : null,
      serverError: null,
      renamedFrom: name === entry.name ? null : entry.name,
      typedNormalized: false
    }
  })
}

/** A line that could not be read as NAME=value: there is nothing to edit, only to leave out. */
export function isUnreadable(row: PasteRow): boolean {
  return row.parseIssue === 'syntax' && row.name === ''
}

export function rowIssue(row: PasteRow, overridden: boolean): DotenvPasteIssue | null {
  return (
    row.serverError ??
    (row.parseIssue && row.parseIssue !== 'overridden' ? row.parseIssue : null) ??
    cloudSecretNameError(row.name) ??
    cloudSecretValueError(row.name, row.value) ??
    (overridden ? 'overridden' : null)
  )
}

export function PasteRowEditor({
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
  const removeButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={onRemove}
      aria-label={t('cloudSecrets.paste.remove', 'Leave out {{name}}', {
        name: row.name || t('cloudSecrets.paste.lineName', 'line {{line}}', { line: row.line })
      })}
    >
      <X />
    </Button>
  )
  if (isUnreadable(row)) {
    return (
      <li data-paste-row={row.id} className="flex items-center gap-2 px-3 py-2">
        <AlertCircle aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {t('cloudSecrets.paste.skippedLine', 'Line {{line}} · skipped', { line: row.line })}
          </span>
          {' · '}
          {cloudSecretsErrorCopy('syntax', t)}
        </p>
        {removeButton}
      </li>
    )
  }
  const note = row.renamedFrom
    ? t('cloudSecrets.paste.renamed', 'Renamed from {{name}}', { name: row.renamedFrom })
    : row.typedNormalized
      ? t('cloudSecrets.paste.normalized', 'Spaces and dashes become underscores')
      : null
  const status = issue
    ? cloudSecretsErrorCopy(issue, t)
    : replaces
      ? t('cloudSecrets.paste.replaces', 'Replaces the saved value')
      : t('cloudSecrets.paste.adds', 'New')
  return (
    <li data-paste-row={row.id} className="space-y-1 px-3 py-2">
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
          onChange={(event) => {
            const input = event.target
            const typed = input.value
            const caret = input.selectionStart
            const name = normalizeSecretName(typed)
            onChange({
              name,
              // The pasted spelling no longer describes this name once it is edited.
              renamedFrom: null,
              typedNormalized: typed !== '' && (row.typedNormalized || /[\s-]/.test(typed)),
              parseIssue: null,
              serverError: null
            })
            // Rewriting keeps the length, so the caret can stay where the user is typing.
            if (name !== typed && caret !== null) {
              requestAnimationFrame(() => input.setSelectionRange(caret, caret))
            }
          }}
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
        {removeButton}
      </div>
      <p
        id={`${id}-issue`}
        className={
          blocking ? 'pl-5.5 text-2xs text-destructive' : 'pl-5.5 text-2xs text-muted-foreground'
        }
      >
        {note ? `${status} · ${note}` : status}
      </p>
    </li>
  )
}
