import { CircleAlert, Copy, ExternalLink } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { AgentIcon } from '@/lib/agent-catalog'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { PasteCodeForm } from './AgentSignInPasteCodeForm'
import type { AgentSignInGate } from '@/lib/agent-sign-in/agent-sign-in-gate'

export type AgentSignInCardActions = {
  signIn: () => void
  retry: () => void
  useCode: () => void
  submitCode: (code: string) => void
  openLink: (url: string) => void
  copyText: (text: string) => void
  cancel: () => void
  skip: () => void
}

const AGENT_NAME = { claude: 'Claude', codex: 'Codex' } as const
const SIGN_IN_SITE = { claude: 'claude.ai', codex: 'chatgpt.com' } as const

function QueuedPrompt({
  prompt,
  label
}: {
  prompt: string
  label: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-l-2 border-border pl-2.5">
      <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">{label}</span>
      <span className="truncate text-xs text-foreground" title={prompt}>
        {prompt}
      </span>
    </div>
  )
}

function ErrorLine({ title, detail }: { title: string; detail: string }): React.JSX.Element {
  return (
    <div role="alert" className="flex items-start gap-2 text-xs leading-5">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <p className="min-w-0">
        <span className="font-medium text-foreground">{title}</span>{' '}
        <span className="text-muted-foreground">{detail}</span>
      </p>
    </div>
  )
}

/** Inline sign-in for an agent about to start on a host where it isn't signed in. */
export function AgentSignInCard({
  gate,
  actions
}: {
  gate: AgentSignInGate
  actions: AgentSignInCardActions
}): React.JSX.Element {
  const t = useTranslate()
  const name = AGENT_NAME[gate.agent]
  const host = gate.hostLabel
  const view = gate.view
  const title =
    view.step === 'waiting'
      ? t('agentSignIn.waitingTitle', 'Finish in your browser')
      : view.step === 'signed'
        ? t('agentSignIn.signedTitle', 'Signed in to {{agent}} on {{host}}', { agent: name, host })
        : t('agentSignIn.title', 'Sign in to {{agent}} on {{host}}', { agent: name, host })
  const busy = view.step === 'starting'
  const cancel = (
    <Button type="button" variant="ghost" size="sm" onClick={actions.cancel}>
      {t('agentSignIn.cancel', 'Cancel')}
    </Button>
  )
  const codeLabel =
    gate.agent === 'claude'
      ? t('agentSignIn.pasteInstead', 'Paste a code instead')
      : t('agentSignIn.deviceInstead', 'Use a device code instead')

  let body: React.ReactNode = null
  if (view.step === 'need' || view.step === 'starting') {
    body = gate.codeOnly
      ? t(
          'agentSignIn.codeOnlyBody',
          '{{host}} runs an older Orca, so sign-in needs a code. The sign-in is saved on {{host}}, not here.',
          { host }
        )
      : t(
          'agentSignIn.needBody',
          'Approve once in your browser. The sign-in is saved on {{host}}, not here.',
          { host }
        )
  } else if (view.step === 'waiting') {
    body = (
      <span className="flex items-center gap-1.5">
        <LoadingSpinner className="size-3 shrink-0" />
        {gate.agent === 'claude'
          ? t('agentSignIn.waitingClaude', 'Click Authorize on {{site}}.', {
              site: SIGN_IN_SITE.claude
            })
          : t('agentSignIn.waitingCodex', 'Click Continue on {{site}}.', {
              site: SIGN_IN_SITE.codex
            })}
      </span>
    )
  } else if (view.step === 'signed') {
    body = view.email ? t('agentSignIn.signedAs', 'as {{email}}', { email: view.email }) : null
  } else if (view.step === 'paste') {
    body = t('agentSignIn.pasteBody', 'Sign in on the page, then paste the code it shows.')
  } else if (view.step === 'device') {
    body = t('agentSignIn.deviceBody', 'Open the page and enter this code.')
  }

  return (
    <div
      role="dialog"
      aria-label={title}
      data-agent-sign-in={view.step}
      className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xs motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          actions.cancel()
        }
      }}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
          <AgentIcon agent={gate.agent} size={16} />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {body ? <div className="text-xs text-muted-foreground">{body}</div> : null}
        </div>
      </div>

      {view.step === 'error' ? <AgentSignInError gate={gate} view={view} /> : null}

      {view.step === 'paste' ? (
        <>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => actions.openLink(view.url)}
            >
              <ExternalLink />
              {t('agentSignIn.openPage', 'Open sign-in page')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => actions.copyText(view.url)}
            >
              <Copy />
              {t('agentSignIn.copyLink', 'Copy link')}
            </Button>
          </div>
          <PasteCodeForm
            submitting={view.submitting}
            refusal={view.refusal}
            onSubmit={actions.submitCode}
          />
        </>
      ) : null}

      {view.step === 'device' ? (
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-muted px-2.5 py-1 font-mono text-sm tracking-widest text-foreground">
            {view.userCode}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => actions.copyText(view.userCode)}
          >
            <Copy />
            {t('agentSignIn.copyCode', 'Copy code')}
          </Button>
          <span className="flex-1" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => actions.openLink(view.url)}
          >
            <ExternalLink />
            {t('agentSignIn.openPageShort', 'Open page')}
          </Button>
        </div>
      ) : null}

      {gate.prompt ? (
        <QueuedPrompt
          prompt={gate.prompt}
          label={
            view.step === 'signed' ? (
              <>
                <LoadingSpinner className="size-3" />
                {t('agentSignIn.sending', 'Starting {{agent}} and sending', { agent: name })}
              </>
            ) : (
              t('agentSignIn.queued', 'Sends after sign-in')
            )
          }
        />
      ) : null}

      {view.step === 'signed' ? null : view.step === 'waiting' ? (
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => actions.openLink(view.url)}
          >
            <ExternalLink />
            {t('agentSignIn.openAgain', 'Open again')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => actions.copyText(view.url)}
          >
            <Copy />
            {t('agentSignIn.copyLink', 'Copy link')}
          </Button>
          <span className="flex-1" />
          {cancel}
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          {cancel}
          {view.step === 'error' && view.kind === 'port_busy' && !gate.codeOnly ? (
            <Button type="button" variant="outline" size="sm" onClick={actions.useCode}>
              {gate.agent === 'claude'
                ? t('agentSignIn.pasteShort', 'Paste a code')
                : t('agentSignIn.deviceShort', 'Use a device code')}
            </Button>
          ) : null}
          {view.step === 'need' || view.step === 'starting' ? (
            <Button
              type="button"
              size="sm"
              autoFocus
              disabled={busy}
              onClick={actions.signIn}
              className="min-w-40"
            >
              {busy ? <LoadingSpinner className="size-4" /> : null}
              {gate.codeOnly
                ? t('agentSignIn.signInCode', 'Sign in')
                : t('agentSignIn.signIn', 'Sign in with browser')}
            </Button>
          ) : view.step === 'error' ? (
            <Button type="button" size="sm" autoFocus onClick={actions.retry}>
              {t('agentSignIn.tryAgain', 'Try again')}
            </Button>
          ) : null}
        </div>
      )}

      {view.step === 'need' || view.step === 'starting' || view.step === 'error' ? (
        <div className="-mx-4 -mb-1 flex items-center gap-1.5 border-t border-border px-2.5 pt-2 text-xs text-muted-foreground">
          {gate.codeOnly ? null : (
            <Button
              type="button"
              variant="ghost"
              size="xs"

              onClick={actions.useCode}
            >
              {codeLabel}
            </Button>
          )}
          <span className="flex-1" />
          <Button
            type="button"
            variant="ghost"
            size="xs"

            onClick={actions.skip}
          >
            {t('agentSignIn.startAnyway', 'Start without signing in')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function AgentSignInError({
  gate,
  view
}: {
  gate: AgentSignInGate
  view: Extract<AgentSignInGate['view'], { step: 'error' }>
}): React.JSX.Element {
  const t = useTranslate()
  const name = AGENT_NAME[gate.agent]
  switch (view.kind) {
    case 'port_busy':
      return (
        <ErrorLine
          title={t('agentSignIn.errors.portBusy', 'Port {{port}} is busy on this computer.', {
            port: String(view.port ?? '')
          })}
          detail={t(
            'agentSignIn.errors.portBusyDetail',
            'Another {{agent}} sign-in is probably open. Close it and try again.',
            { agent: name }
          )}
        />
      )
    case 'timeout':
      return (
        <ErrorLine
          title={t('agentSignIn.errors.timeout', 'Sign-in timed out.')}
          detail={t(
            'agentSignIn.errors.timeoutDetail',
            'Nothing came back from the browser in time.'
          )}
        />
      )
    case 'declined':
      return (
        <ErrorLine
          title={t('agentSignIn.errors.declined', 'Not authorized.')}
          detail={t(
            'agentSignIn.errors.declinedDetail',
            '{{site}} reported that the sign-in was declined.',
            { site: SIGN_IN_SITE[gate.agent] }
          )}
        />
      )
    case 'offline':
      return (
        <ErrorLine
          title={t('agentSignIn.errors.offline', "Can't reach {{host}}.", { host: gate.hostLabel })}
          detail={t(
            'agentSignIn.errors.offlineDetail',
            'Your prompt stays here until it reconnects.'
          )}
        />
      )
    case 'failed':
      return (
        <ErrorLine
          title={t('agentSignIn.errors.failed', 'Sign-in failed.')}
          detail={view.message}
        />
      )
  }
}
