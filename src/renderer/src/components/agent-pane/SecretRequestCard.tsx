import React from 'react'
import { CircleCheck, KeyRound, Loader2, RotateCw } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { SecretValueInput } from '@/components/settings/cloud-secrets/SecretValueInput'
import { cloudSecretScopeLabel } from '@/components/settings/cloud-secrets/cloud-secrets-copy'
import { cn } from '@/lib/utils'
import type { SecretRequestScope } from '../../../../shared/secret-request-contract'

export type SecretRequestCardPhase =
  | 'open'
  | 'saving'
  /** The save didn't reach Orca Cloud; nothing changed. */
  | 'failed'
  | 'saved'
  | 'savedAfterExpiry'
  | 'expired'

export type SecretRequestCardModel = {
  /** Display name ("Claude"), or null when orcad couldn't tell which agent asked. */
  agent: string | null
  name: string
  /** Untrusted agent text; rendered as plain text only. */
  reason: string | null
  /** The agent suggested Repository. A hint only: it never preselects (D2). */
  suggestedRepo: boolean
  /** Personal always; Repository only when the person can write it. Never Shared (D6). */
  scopes: readonly SecretRequestScope[]
  scope: SecretRequestScope
  value: string
  phase: SecretRequestCardPhase
  /** A refusal for this name or value (reserved name, too large…), shown under the field. */
  fieldError: string | null
  /** Other requests waiting on this pane. */
  more: number
  /** Restart is offered where Orca can restart that agent in the pane. */
  canRestart: boolean
}

export type SecretRequestCardActions = {
  onValueChange: (value: string) => void
  onScopeChange: (scope: SecretRequestScope) => void
  onAdd: () => void
  onNotNow: () => void
  onRetry: () => void
  onRestart: () => void
  onDismiss: () => void
  /** Focus entered or left the card (the desktop keeps the request alive while it has focus). */
  onFocusChange?: (focused: boolean) => void
}

const NAME_SLOT = '\u0000'

/** The translated title with the variable name set in monospace. */
function titleFor(agent: string | null, name: string, t: Translate): React.ReactNode {
  const text = agent
    ? t('secretRequest.title', '{{agent}} asked for {{name}}', { agent, name: NAME_SLOT })
    : t('secretRequest.titleUnknown', 'An agent asked for {{name}}', { name: NAME_SLOT })
  return text.split(NAME_SLOT).map((part, index) => (
    <React.Fragment key={index}>
      {index > 0 ? <code className="font-mono text-[0.95em]">{name}</code> : null}
      {part}
    </React.Fragment>
  ))
}

/** Title text for aria-label and announcements. */
export function secretRequestTitle(agent: string | null, name: string, t: Translate): string {
  return agent
    ? t('secretRequest.title', '{{agent}} asked for {{name}}', { agent, name })
    : t('secretRequest.titleUnknown', 'An agent asked for {{name}}', { name })
}

/** Plain text clamped to two lines, with Show more when it overflows. Never linkified. */
function UntrustedReason({ reason, from }: { reason: string; from: string }): React.JSX.Element {
  const t = useTranslate()
  const ref = React.useRef<HTMLSpanElement>(null)
  const [expanded, setExpanded] = React.useState(false)
  const [overflows, setOverflows] = React.useState(false)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (element && !expanded) {
      setOverflows(element.scrollHeight > element.clientHeight + 1)
    }
  }, [reason, expanded])
  return (
    <figure className="flex min-w-0 flex-col gap-0.5 border-l-2 border-border pl-2.5 text-xs leading-5 text-muted-foreground">
      <blockquote className="min-w-0">
        <span ref={ref} className={cn('break-words', !expanded && 'line-clamp-2')}>
          {`“${reason}”`}
        </span>
      </blockquote>
      <figcaption className="flex items-center gap-2">
        <span>{from}</span>
        {overflows || expanded ? (
          <button
            type="button"
            className="rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded
              ? t('secretRequest.showLess', 'Show less')
              : t('secretRequest.showMore', 'Show more')}
          </button>
        ) : null}
      </figcaption>
    </figure>
  )
}

/**
 * S4-b: an agent in an Orca Cloud workspace asked for a secret. The value goes from this card to
 * Orca Cloud only; the agent is told it's ready and never gets it from Orca. Non-modal: it never takes
 * focus from the terminal.
 */
export function SecretRequestCard({
  model,
  actions,
  inputRef,
  className
}: {
  model: SecretRequestCardModel
  actions: SecretRequestCardActions
  /** Lets F6 move focus into the card. */
  inputRef?: React.Ref<HTMLDivElement>
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const id = React.useId()
  const titleId = `${id}-title`
  const helpId = `${id}-help`
  const errorId = `${id}-error`
  const agentName = model.agent ?? t('secretRequest.anAgent', 'an agent')
  const done = model.phase === 'saved' || model.phase === 'savedAfterExpiry'
  const saving = model.phase === 'saving'
  const canSave = model.value.length > 0 && !saving

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && !done && model.phase !== 'expired') {
      event.stopPropagation()
      actions.onNotNow()
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-secret-request-card=""
      onKeyDown={onKeyDown}
      onFocus={() => actions.onFocusChange?.(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          actions.onFocusChange?.(false)
        }
      }}
      className={cn(
        'flex w-full flex-col gap-3 rounded-lg border border-border bg-popover p-4 font-sans text-sm text-popover-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in-0',
        className
      )}
    >
      {done ? (
        <div className="flex items-start gap-3">
          <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div role="status" className="min-w-0 flex-1 space-y-1">
            <p id={titleId} className="font-medium text-foreground">
              {model.phase === 'savedAfterExpiry'
                ? t(
                    'secretRequest.savedAfterExpiry',
                    'Saved. {{agent}} stopped waiting, so tell it the secret is ready.',
                    { agent: model.agent ?? t('secretRequest.theAgent', 'The agent') }
                  )
                : model.scope === 'repo'
                  ? t('secretRequest.doneRepo', '{{name}} added to this repository’s secrets.', {
                      name: model.name
                    })
                  : t('secretRequest.done', '{{name}} added to your personal secrets.', {
                      name: model.name
                    })}
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              {model.phase === 'saved'
                ? t(
                    'secretRequest.doneDetail',
                    'New shells get it now. {{agent}} was told it’s ready, and it never gets the value from Orca.',
                    { agent: model.agent ?? t('secretRequest.theAgent', 'The agent') }
                  )
                : t('secretRequest.doneDetailExpired', 'New shells get it now.')}{' '}
              {model.canRestart
                ? t(
                    'secretRequest.restartDetail',
                    'Restart {{agent}} to give its own shell the new value.',
                    { agent: agentName }
                  )
                : null}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {model.canRestart ? (
              <Button type="button" variant="outline" size="xs" onClick={actions.onRestart}>
                <RotateCw aria-hidden />
                {t('secretRequest.restart', 'Restart {{agent}}', { agent: agentName })}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="xs" onClick={actions.onDismiss}>
              {t('secretRequest.dismiss', 'Dismiss')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-2.5">
            <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <h3 id={titleId} className="min-w-0 font-medium break-words text-foreground">
                  {titleFor(model.agent, model.name, t)}
                </h3>
                {model.more > 0 ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t('secretRequest.more', '{{count}} more requests', {
                      count: model.more,
                      defaultValue_one: '{{count}} more request'
                    })}
                  </span>
                ) : null}
              </div>
              {model.reason ? (
                <UntrustedReason
                  reason={model.reason}
                  from={t('secretRequest.from', 'from {{agent}}', { agent: agentName })}
                />
              ) : null}
            </div>
          </div>

          {model.phase === 'expired' ? (
            <InlineError
              tone="neutral"
              title={t('secretRequest.expired', 'This request expired.')}
              detail={t('secretRequest.expiredDetail', '{{agent}} can ask again.', {
                agent: model.agent ?? t('secretRequest.theAgent', 'The agent')
              })}
              action={
                <Button type="button" variant="outline" size="xs" onClick={actions.onDismiss}>
                  {t('secretRequest.dismiss', 'Dismiss')}
                </Button>
              }
            />
          ) : (
            <>
              <div ref={inputRef} tabIndex={-1} className="flex flex-col gap-1.5 outline-none">
                <Label htmlFor={`${id}-value`} className="sr-only">
                  {t('secretRequest.valueLabel', 'Value for {{name}}', { name: model.name })}
                </Label>
                <div className="flex items-start gap-2">
                  <div
                    className="min-w-0 flex-1"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && canSave) {
                        event.preventDefault()
                        actions.onAdd()
                      }
                    }}
                  >
                    <SecretValueInput
                      id={`${id}-value`}
                      value={model.value}
                      onChange={actions.onValueChange}
                      placeholder={t('secretRequest.valuePlaceholder', 'Value')}
                      invalid={model.fieldError !== null}
                      disabled={saving}
                      describedBy={model.fieldError ? `${errorId} ${helpId}` : helpId}
                    />
                  </div>
                  {model.scopes.length > 1 ? (
                    <Select
                      value={model.scope}
                      onValueChange={(next) =>
                        actions.onScopeChange(next === 'repo' ? 'repo' : 'personal')
                      }
                      disabled={saving}
                    >
                      <SelectTrigger
                        size="sm"
                        className="w-32 shrink-0"
                        aria-label={t('secretRequest.scopeLabel', 'Scope for {{name}}', {
                          name: model.name
                        })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {model.scopes.map((scope) => (
                          <SelectItem key={scope} value={scope}>
                            {cloudSecretScopeLabel(scope, t)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="inline-flex h-8 shrink-0 items-center rounded-full border border-border px-2.5 text-xs text-muted-foreground">
                      {cloudSecretScopeLabel('personal', t)}
                    </span>
                  )}
                </div>
                {model.fieldError ? (
                  <p id={errorId} role="alert" className="text-xs text-destructive">
                    {model.fieldError}
                  </p>
                ) : null}
                <p id={helpId} className="text-xs leading-5 text-muted-foreground">
                  {t(
                    'secretRequest.help',
                    'Saved to your Cloud secrets. Commands in this workspace can read it as ${{name}}.',
                    { name: model.name }
                  )}
                </p>
                {model.suggestedRepo && model.scopes.includes('repo') ? (
                  <p className="text-xs text-muted-foreground">
                    {t('secretRequest.repoHint', '{{agent}} suggested Repository', {
                      agent: agentName
                    })}
                  </p>
                ) : null}
              </div>
              {model.phase === 'failed' ? (
                <InlineError
                  title={t('secretRequest.unreachable', 'Couldn’t reach Orca Cloud.')}
                  detail={t('secretRequest.nothingChanged', 'Nothing was changed.')}
                  retryLabel={t('secretRequest.retry', 'Try again')}
                  onRetry={actions.onRetry}
                  density="compact"
                />
              ) : null}
              <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="ghost" size="xs" onClick={actions.onNotNow}>
                  {t('secretRequest.notNow', 'Not now')}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  aria-disabled={!canSave || undefined}
                  aria-busy={saving || undefined}
                  onClick={canSave ? actions.onAdd : undefined}
                  className="aria-disabled:opacity-50"
                >
                  {saving ? <Loader2 aria-hidden className="motion-safe:animate-spin" /> : null}
                  {t('secretRequest.add', 'Add secret')}
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
