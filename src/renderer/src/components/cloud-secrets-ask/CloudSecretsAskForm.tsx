import React from 'react'
import { CircleCheck, ClipboardPaste, KeyRound, Loader2 } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { getIntlLocale } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { SecretValueInput } from '@/components/settings/cloud-secrets/SecretValueInput'
import {
  cloudSecretScopeLabel,
  cloudSecretsErrorCopy
} from '@/components/settings/cloud-secrets/cloud-secrets-copy'
import { cn } from '@/lib/class-names'
import type {
  CloudSecretScope,
  CloudSecretsErrorCode
} from '../../../../shared/cloud-secrets/cloud-secrets-wire'
import {
  isTeamAdmin,
  parseScope,
  writableScopes,
  type CloudSecretsAskData
} from './cloud-secrets-ask-model'

export type CloudSecretsAskPhase = 'editing' | 'saving' | 'failed' | 'saved' | 'skipped'

export type CloudSecretsAskFormState = {
  /** Typed values, by name. Cleared (and the inputs unmounted) once saved. */
  values: Record<string, string>
  scopes: Record<string, CloudSecretScope>
  phase: CloudSecretsAskPhase
  /** Server refusals for single names. */
  refused: Record<string, CloudSecretsErrorCode>
  pasteOpen: boolean
  pasteSummary: { matched: number; count: number; ignored: number } | null
}

export const EMPTY_ASK_STATE: CloudSecretsAskFormState = {
  values: {},
  scopes: {},
  phase: 'editing',
  refused: {},
  pasteOpen: false,
  pasteSummary: null
}

export type CloudSecretsAskFormActions = {
  onValueChange: (name: string, value: string) => void
  onScopeChange: (name: string, scope: CloudSecretScope) => void
  onTogglePaste: () => void
  onPaste: (text: string) => void
  onSave: () => void
  onSkip: () => void
}

/** "A, B and C", in the UI language. */
function listNames(names: readonly string[]): string {
  try {
    return new Intl.ListFormat(getIntlLocale(), { style: 'long', type: 'conjunction' }).format(
      names
    )
  } catch {
    return names.join(', ')
  }
}

function coverageLine(data: CloudSecretsAskData, t: Translate): string {
  return t(
    'cloudSecretsAsk.coverage',
    'The {{environment}} environment uses {{total}}. Your team and this repository provide {{covered}}.',
    {
      environment: data.environmentName,
      total: data.total,
      covered: data.total - data.missing.length
    }
  )
}

/** "2 secrets missing" heading plus its coverage line (shared by the sheet and the dialog). */
export function CloudSecretsAskHeading({
  data,
  headingId,
  action
}: {
  data: CloudSecretsAskData
  headingId: string
  action?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-start gap-3">
      <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0 text-status-warning" />
      <div className="min-w-0 flex-1">
        <h3 id={headingId} className="text-sm font-medium text-foreground">
          {t('cloudSecretsAsk.missing', '{{count}} secrets missing', {
            count: data.missing.length,
            defaultValue_one: '{{count}} secret missing'
          })}
        </h3>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{coverageLine(data, t)}</p>
      </div>
      {action}
    </div>
  )
}

/**
 * S2: the environment's declared names this person doesn't get a value for, asked inline. Never
 * blocks Open; values go to Orca Cloud in one batch and the inputs unmount after the save.
 */
export function CloudSecretsAskForm({
  data,
  state,
  actions,
  className
}: {
  data: CloudSecretsAskData
  state: CloudSecretsAskFormState
  actions: CloudSecretsAskFormActions
  className?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const id = React.useId()
  const headingId = `${id}-heading`
  const admin = isTeamAdmin(data.caller)
  const scopes = writableScopes(data.caller, { repo: data.repoKey !== null, shared: true })
  const filled = data.missing.filter((name) => (state.values[name] ?? '').length > 0)
  const saving = state.phase === 'saving'
  const canSave = filled.length > 0 && !saving

  if (state.phase === 'skipped') {
    return (
      <div className={cn('flex items-start gap-3 py-2', className)}>
        <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          <span className="text-foreground">{t('cloudSecretsAsk.skipped', 'Secrets skipped')}</span>
          {' · '}
          {t('cloudSecretsAsk.skippedDetail', 'Add them later from the workspace’s cloud panel.')}
        </p>
      </div>
    )
  }

  const savedLine =
    state.phase === 'saved' ? (
      <div className="flex items-start gap-3">
        <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {t('cloudSecretsAsk.saved', 'Secrets saved')}
          </p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {t(
              'cloudSecretsAsk.savedDetail',
              'New terminals and agents in this workspace get them within a few seconds.'
            )}
          </p>
        </div>
      </div>
    ) : null

  // Everything saved: just the confirmation.
  if (state.phase === 'saved' && data.missing.length === 0) {
    return (
      <div className={cn('py-2', className)} role="status">
        {savedLine}
      </div>
    )
  }

  const lastName = data.missing.at(-1)
  return (
    <section aria-labelledby={headingId} className={cn('flex flex-col gap-3 py-2', className)}>
      <div role="status" className="contents">
        {savedLine}
      </div>
      <CloudSecretsAskHeading
        data={data}
        headingId={headingId}
        action={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-expanded={state.pasteOpen}
            onClick={actions.onTogglePaste}
            disabled={saving}
          >
            <ClipboardPaste aria-hidden />
            {t('cloudSecretsAsk.pasteEnv', 'Paste .env')}
          </Button>
        }
      />
      {!admin && data.built ? (
        <p className="ps-7 text-xs leading-5 text-muted-foreground">
          {t(
            'cloudSecretsAsk.buildTeamOnly',
            'The environment build only uses team values. Ask an owner or admin to add {{name}} as team secrets.',
            {
              name: listNames(data.missing),
              count: data.missing.length,
              defaultValue_one:
                'The environment build only uses team values. Ask an owner or admin to add {{name}} as a team secret.'
            }
          )}
        </p>
      ) : null}
      {state.pasteOpen ? (
        <div className="flex flex-col gap-1.5 ps-7">
          <label htmlFor={`${id}-paste`} className="text-xs text-muted-foreground">
            {t('cloudSecretsAsk.pasteLabel', 'Paste the contents of a .env file')}
          </label>
          <Textarea
            id={`${id}-paste`}
            variant="code"
            value=""
            placeholder={t('cloudSecretsAsk.pastePlaceholder', 'NAME=value')}
            spellCheck={false}
            autoComplete="off"
            data-1p-ignore=""
            className="min-h-16"
            // The text is read at once and dropped: only the matching values stay, in the masked fields.
            onChange={(event) => actions.onPaste(event.target.value)}
          />
        </div>
      ) : null}
      {state.pasteSummary ? (
        <p role="status" className="ps-7 text-xs text-muted-foreground">
          {t(
            'cloudSecretsAsk.pasteFound',
            'Found {{matched}} of {{count}}. {{ignored}} other lines ignored.',
            {
              matched: state.pasteSummary.matched,
              count: state.pasteSummary.count,
              ignored: state.pasteSummary.ignored
            }
          )}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2 ps-7">
        {data.missing.map((name) => {
          const refusal = state.refused[name]
          const errorId = `${id}-${name}-error`
          return (
            <li
              key={name}
              className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1"
            >
              <label
                htmlFor={`${id}-${name}`}
                className="h-8 min-w-0 truncate font-mono text-xs leading-8 font-normal text-foreground"
                title={name}
              >
                {name}
              </label>
              <div
                className="min-w-0"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && name === lastName && canSave) {
                    event.preventDefault()
                    actions.onSave()
                  }
                }}
              >
                <SecretValueInput
                  id={`${id}-${name}`}
                  value={state.values[name] ?? ''}
                  onChange={(value) => actions.onValueChange(name, value)}
                  placeholder={t('cloudSecretsAsk.valuePlaceholder', 'Value')}
                  invalid={Boolean(refusal)}
                  disabled={saving}
                  describedBy={refusal ? errorId : undefined}
                />
              </div>
              {scopes.length > 1 ? (
                <Select
                  value={state.scopes[name] ?? 'personal'}
                  onValueChange={(scope) => actions.onScopeChange(name, parseScope(scope))}
                  disabled={saving}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-32"
                    aria-label={t('cloudSecretsAsk.scopeLabel', 'Scope for {{name}}', { name })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {scopes.map((scope) => (
                      <SelectItem key={scope} value={scope}>
                        {cloudSecretScopeLabel(scope, t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className="inline-flex h-8 items-center rounded-full border border-border px-2.5 text-xs text-muted-foreground">
                  {cloudSecretScopeLabel('personal', t)}
                </span>
              )}
              {refusal ? (
                <p
                  id={errorId}
                  role="alert"
                  className="col-start-2 col-end-4 text-xs text-destructive"
                >
                  {refusal === 'org_admin_required'
                    ? t(
                        'cloudSecretsAsk.memberRefused',
                        'Only owners and admins can save team or repository values. Choose Personal.'
                      )
                    : cloudSecretsErrorCopy(refusal, t)}
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
      {state.phase === 'failed' ? (
        <InlineError
          className="ms-7"
          title={t('cloudSecretsAsk.unreachable', 'Couldn’t reach Orca Cloud.')}
          detail={t('cloudSecretsAsk.nothingChanged', 'Nothing was changed.')}
          retryLabel={t('cloudSecretsAsk.retry', 'Try again')}
          onRetry={actions.onSave}
          density="compact"
        />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 ps-7">
        <p className="min-w-0 flex-1 basis-60 text-xs leading-5 text-muted-foreground">
          {admin
            ? t('cloudSecrets.editor.help', 'Write-only. You won’t see it again after saving.')
            : t(
                'cloudSecretsAsk.memberFooter',
                'Saved to your personal Cloud secrets, so only your workspaces get them. To set them for the whole team, ask an owner or admin.'
              )}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={actions.onSkip}
            disabled={saving}
          >
            {t('cloudSecretsAsk.skip', 'Skip')}
          </Button>
          <Button
            type="button"
            size="xs"
            aria-disabled={!canSave || undefined}
            aria-busy={saving || undefined}
            onClick={canSave ? actions.onSave : undefined}
          >
            {saving ? <Loader2 aria-hidden className="motion-safe:animate-spin" /> : null}
            {filled.length === 0
              ? t('cloudSecretsAsk.saveNone', 'Save')
              : t('cloudSecretsAsk.save', 'Save {{count}} secrets', {
                  count: filled.length,
                  defaultValue_one: 'Save secret'
                })}
          </Button>
        </div>
      </div>
    </section>
  )
}
