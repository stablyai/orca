import React from 'react'
import { ChevronDown, ChevronUp, KeyRound, Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Label } from '@/components/ui/label'
import { SecretValueInput } from '@/components/settings/cloud-secrets/SecretValueInput'
import { cn } from '@/lib/class-names'
import type { SecretRequestScope } from '../../../../shared/secret-request-contract'
import {
  SecretRequestDone,
  SecretRequestScopeControl,
  SecretRequestTitle,
  UntrustedReason
} from './SecretRequestCardParts'

export { secretRequestTitle } from './SecretRequestCardParts'

export type SecretRequestCardPhase =
  | 'open'
  | 'saving'
  /** The save didn't reach Orca Cloud; nothing changed. */
  | 'failed'
  | 'saved'
  /** Saved, but the agent wasn't told: the request expired first, or orcad didn't answer (D3). */
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
  /**
   * Personal, plus Repository when the person can write it. Never Shared (D6). In a shared workspace
   * Personal is left out (SEC-5), so this can be empty: then the card says who can add it instead.
   */
  scopes: readonly SecretRequestScope[]
  /** The workspace is shared with teammates, so it gets no Personal secrets (SEC-5). */
  sharedWorkspace: boolean
  scope: SecretRequestScope
  value: string
  phase: SecretRequestCardPhase
  /** A refusal for this name or value (reserved name, too large…), shown under the field. */
  fieldError: string | null
  /** Other requests waiting on this pane. */
  more: number
  /** Restart is offered only on the asking agent's own pane. */
  canRestart: boolean
  /** Folded to one line so the output under it can be read, without declining. */
  collapsed: boolean
}

export type SecretRequestCardActions = {
  onValueChange: (value: string) => void
  onScopeChange: (scope: SecretRequestScope) => void
  onAdd: () => void
  onNotNow: () => void
  onRetry: () => void
  onRestart: () => void
  onDismiss: () => void
  onToggleCollapsed: () => void
  /** Fold to the one-line pill (the person scrolled or typed in the pane under it). */
  onCollapse: () => void
  /** Opens the Agent accounts & secrets panel on this name; absent until the panel exists. */
  onDetails?: () => void
  /** Focus entered or left the card (the desktop keeps the request alive while it has focus). */
  onFocusChange?: (focused: boolean) => void
}

/**
 * S4-b: an agent in an Orca Cloud workspace asked for a secret. The value goes from this card to
 * Orca Cloud only (never through the agent); once saved it is a plain env var any command in the
 * workspace can read, the agent included. The agent is told it's ready. Non-modal: it never takes
 * focus from the terminal (F6 moves focus in and back out).
 */
export function SecretRequestCard({
  model,
  actions,
  rootRef,
  className
}: {
  model: SecretRequestCardModel
  actions: SecretRequestCardActions
  rootRef?: React.Ref<HTMLDivElement>
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
  const canSave = model.value.length > 0 && !saving && model.scopes.length > 0
  const ownRef = React.useRef<HTMLDivElement>(null)
  const focusedWithin = React.useRef(false)

  // When the form gives way to the result, focus that was in it lands on Dismiss (never Restart, so a
  // second Enter can't relaunch the agent) instead of falling to the page.
  React.useLayoutEffect(() => {
    const root = ownRef.current
    if (done && focusedWithin.current && root && !root.contains(document.activeElement)) {
      root.querySelector<HTMLElement>('[data-secret-request-dismiss]')?.focus()
    }
  }, [done])

  const setRefs = (node: HTMLDivElement | null): void => {
    ownRef.current = node
    if (typeof rootRef === 'function') {
      rootRef(node)
    } else if (rootRef) {
      rootRef.current = node
    }
  }

  const header = (
    <div className="flex items-start gap-2.5">
      <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 id={titleId} className="min-w-0 font-medium break-words text-foreground">
          <SecretRequestTitle agent={model.agent} name={model.name} />
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
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="-my-0.5 shrink-0"
        aria-expanded={!model.collapsed}
        aria-label={
          model.collapsed
            ? t('secretRequest.expand', 'Show request')
            : t('secretRequest.collapse', 'Hide request')
        }
        onClick={actions.onToggleCollapsed}
      >
        {model.collapsed ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
      </Button>
    </div>
  )

  return (
    <div
      ref={setRefs}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-secret-request-card=""
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !done && !saving && model.phase !== 'expired') {
          event.stopPropagation()
          actions.onNotNow()
        }
      }}
      onFocus={() => {
        focusedWithin.current = true
        actions.onFocusChange?.(true)
      }}
      onBlur={(event) => {
        const root = event.currentTarget
        if (root.contains(event.relatedTarget)) {
          return
        }
        // A control that unmounts (Add → result) blurs with nowhere to go; that isn't leaving.
        window.setTimeout(() => {
          if (!root.isConnected || root.contains(document.activeElement)) {
            return
          }
          if (document.activeElement === document.body) {
            return
          }
          focusedWithin.current = false
          actions.onFocusChange?.(false)
        }, 0)
      }}
      className={cn(
        'flex w-full flex-col gap-3 rounded-lg border border-border bg-popover font-sans text-sm text-popover-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in-0',
        model.collapsed ? 'px-3 py-2' : 'p-4',
        className
      )}
    >
      {done ? (
        <SecretRequestDone
          agent={model.agent}
          name={model.name}
          scope={model.scope}
          toldAgent={model.phase === 'saved'}
          canRestart={model.canRestart}
          titleId={titleId}
          onRestart={actions.onRestart}
          onDismiss={actions.onDismiss}
        />
      ) : model.collapsed ? (
        header
      ) : (
        <>
          {header}
          {model.reason ? (
            <div className="ps-6.5">
              <UntrustedReason
                reason={model.reason}
                from={
                  model.agent
                    ? t('secretRequest.from', 'from {{agent}}', { agent: model.agent })
                    : null
                }
              />
            </div>
          ) : null}
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
              {model.scopes.length === 0 ? (
                <InlineError
                  tone="neutral"
                  title={t(
                    'secretRequest.sharedNoScope',
                    'This workspace is shared, so it doesn’t get personal secrets.'
                  )}
                  detail={t(
                    'secretRequest.sharedAskAdmin',
                    'Ask an owner or admin to add {{name}} to this repository’s secrets.',
                    { name: model.name }
                  )}
                  density="compact"
                />
              ) : (
              <div data-secret-request-field="" className="flex flex-col gap-1.5">
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
                  <SecretRequestScopeControl
                    name={model.name}
                    scopes={model.scopes}
                    scope={model.scope}
                    disabled={saving}
                    onChange={actions.onScopeChange}
                  />
                </div>
                {model.fieldError ? (
                  <p id={errorId} role="alert" className="text-xs text-destructive">
                    {model.fieldError}
                  </p>
                ) : null}
                <p id={helpId} className="text-xs leading-5 text-muted-foreground">
                  {t(
                    'secretRequest.helpBeforeSave',
                    'Saves to your Cloud secrets. Commands in this workspace can read it as ${{name}}.',
                    { name: model.name }
                  )}
                  {model.sharedWorkspace
                    ? ` ${t(
                        'secretRequest.sharedRepoOnly',
                        'This workspace is shared, so it only gets repository and shared values.'
                      )}`
                    : null}
                </p>
                {model.suggestedRepo && model.scopes.includes('repo') ? (
                  <p className="text-xs text-muted-foreground">
                    {t('secretRequest.repoHint', '{{agent}} suggested Repository', {
                      agent: agentName
                    })}
                  </p>
                ) : null}
              </div>
              )}
              {model.phase === 'failed' ? (
                <InlineError
                  title={t('secretRequest.unreachable', 'Couldn’t reach Orca Cloud.')}
                  detail={t('secretRequest.nothingChanged', 'Nothing was changed.')}
                  retryLabel={t('secretRequest.retry', 'Try again')}
                  onRetry={actions.onRetry}
                  density="compact"
                />
              ) : null}
              <div className="flex items-center gap-2">
                {actions.onDetails ? (
                  <Button type="button" variant="ghost" size="xs" onClick={actions.onDetails}>
                    {t('agentHostPanel.details', 'Details')}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="ms-auto"
                  aria-disabled={saving || undefined}
                  onClick={saving ? undefined : actions.onNotNow}
                >
                  {t('secretRequest.notNow', 'Not now')}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  aria-disabled={!canSave || undefined}
                  aria-busy={saving || undefined}
                  onClick={canSave ? actions.onAdd : undefined}
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
