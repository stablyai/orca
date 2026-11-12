import React from 'react'
import { CircleCheck, RotateCw } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cloudSecretScopeLabel } from '@/components/settings/cloud-secrets/cloud-secrets-copy'
import { cn } from '@/lib/class-names'
import type { SecretRequestScope } from '../../../../shared/secret-request-contract'

const NAME_SLOT = '\u0000'

/** The translated title with the variable name set in monospace. */
export function SecretRequestTitle({
  agent,
  name
}: {
  agent: string | null
  name: string
}): React.JSX.Element {
  const t = useTranslate()
  const text = agent
    ? t('secretRequest.title', '{{agent}} asked for {{name}}', { agent, name: NAME_SLOT })
    : t('secretRequest.titleUnknown', 'A command asked for {{name}}', { name: NAME_SLOT })
  const at = text.indexOf(NAME_SLOT)
  if (at === -1) {
    return <>{text}</>
  }
  return (
    <>
      {text.slice(0, at)}
      <code className="font-mono text-[0.95em]">{name}</code>
      {text.slice(at + NAME_SLOT.length)}
    </>
  )
}

/** Title text for aria-label and announcements. */
export function secretRequestTitle(agent: string | null, name: string, t: Translate): string {
  return agent
    ? t('secretRequest.title', '{{agent}} asked for {{name}}', { agent, name })
    : t('secretRequest.titleUnknown', 'A command asked for {{name}}', { name })
}

/** Plain text clamped to two lines, with Show more when it overflows. Never linkified. */
export function UntrustedReason({
  reason,
  from
}: {
  reason: string
  /** "from Claude"; null when orcad couldn't tell who asked (the title already says so). */
  from: string | null
}): React.JSX.Element {
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
      {from || overflows || expanded ? (
        <figcaption className="flex items-center gap-2">
          {from ? <span>{from}</span> : null}
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
      ) : null}
    </figure>
  )
}

export function SecretRequestScopeControl({
  name,
  scopes,
  scope,
  disabled,
  onChange
}: {
  name: string
  scopes: readonly SecretRequestScope[]
  scope: SecretRequestScope
  disabled: boolean
  onChange: (scope: SecretRequestScope) => void
}): React.JSX.Element {
  const t = useTranslate()
  if (scopes.length < 2) {
    return (
      <span className="inline-flex h-8 shrink-0 items-center rounded-full border border-border px-2.5 text-xs text-muted-foreground">
        {cloudSecretScopeLabel('personal', t)}
      </span>
    )
  }
  return (
    <Select
      value={scope}
      onValueChange={(next) => onChange(next === 'repo' ? 'repo' : 'personal')}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        className="w-32 shrink-0"
        aria-label={t('secretRequest.scopeLabel', 'Scope for {{name}}', { name })}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {scopes.map((option) => (
          <SelectItem key={option} value={option}>
            {cloudSecretScopeLabel(option, t)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The saved state's headline; also what the live region announces before the card goes away. */
export function secretRequestDoneTitle(
  args: { agent: string | null; name: string; scope: SecretRequestScope; toldAgent: boolean },
  t: Translate
): string {
  if (!args.toldAgent) {
    return t(
      'secretRequest.savedAfterExpiry',
      'Saved. {{agent}} stopped waiting, so tell it the secret is ready.',
      { agent: args.agent ?? t('secretRequest.theAgent', 'The agent') }
    )
  }
  return args.scope === 'repo'
    ? t('secretRequest.doneRepo', '{{name}} added to this repository’s secrets.', {
        name: args.name
      })
    : t('secretRequest.done', '{{name}} added to your personal secrets.', { name: args.name })
}

/** Saved: when the value reaches new shells, whether the agent was told, and Restart {{agent}} (Q5). */
export function SecretRequestDone({
  agent,
  name,
  scope,
  toldAgent,
  canRestart,
  titleId,
  onRestart,
  onDismiss
}: {
  agent: string | null
  name: string
  scope: SecretRequestScope
  /** False when the request expired first or orcad didn't answer: the agent wasn't told. */
  toldAgent: boolean
  canRestart: boolean
  titleId: string
  onRestart: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const theAgent = agent ?? t('secretRequest.theAgent', 'The agent')
  const agentName = agent ?? t('secretRequest.anAgent', 'an agent')
  return (
    <div className="flex items-start gap-3">
      <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div role="status" className="min-w-0 flex-1 space-y-1">
        <p id={titleId} className="font-medium text-foreground">
          {secretRequestDoneTitle({ agent, name, scope, toldAgent }, t)}
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          {toldAgent
            ? t(
                'secretRequest.doneDetail',
                'New shells get it now. {{agent}} was told it’s ready.',
                { agent: theAgent }
              )
            : t('secretRequest.doneDetailExpired', 'New shells get it now.')}{' '}
          {canRestart
            ? t(
                'secretRequest.restartDetail',
                'Restart {{agent}} to give its own shell the new value.',
                { agent: agentName }
              )
            : null}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {canRestart ? (
          <Button type="button" variant="outline" size="xs" onClick={onRestart}>
            <RotateCw aria-hidden />
            {t('secretRequest.restart', 'Restart {{agent}}', { agent: agentName })}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-secret-request-dismiss=""
          onClick={onDismiss}
        >
          {t('secretRequest.dismiss', 'Dismiss')}
        </Button>
      </div>
    </div>
  )
}
