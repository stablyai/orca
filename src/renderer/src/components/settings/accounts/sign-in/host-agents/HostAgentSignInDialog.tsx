import { useState, useSyncExternalStore } from 'react'
import { Check, LogIn, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import {
  refreshHostAgentSignInStatus,
  signInAgentOnHost,
  type HostAgentSignInView
} from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import {
  cancelHostAccountSignIn,
  runningHostAccountSignInOwner,
  subscribeHostAccountSignIns
} from '@/runtime/provider-accounts/sign-in/runtime-host-account-sign-in-client'
import { CODEX_LOGIN_CANCELLED_MESSAGE } from '../../../../../../../shared/codex-auth-errors'
import {
  HOST_AGENT_SIGN_IN_AGENTS,
  type HostAgentSignInAgent,
  type HostAgentSignInEntry
} from '../../../../../../../shared/host-agent-sign-in-status'
import { LoadingSpinner } from '../../../../LoadingSpinner'
import { HostAccountSignInPrompt } from '../HostAccountSignInPrompt'
import {
  closeHostAgentSignInDialog,
  readHostAgentSignInDialogTarget,
  subscribeHostAgentSignInDialog,
  type HostAgentSignInDialogTarget
} from './host-agent-sign-in-dialog-state'
import { useHostAgentSignInView } from './use-host-agent-sign-in-view'

const CANCELLED_MESSAGES = new Set(['Claude sign-in was cancelled.', CODEX_LOGIN_CANCELLED_MESSAGE])

export type HostAgentSignInRowsProps = {
  environmentId: string
  hostLabel: string
  view: HostAgentSignInView
  /** The agent whose sign-in runs on this host, if any. */
  runningAgent: HostAgentSignInAgent | null
  errors: Partial<Record<HostAgentSignInAgent, string>>
  onSignIn: (agent: HostAgentSignInAgent) => void
  onRecheck: () => void
}

function StatusText({ entry }: { entry: HostAgentSignInEntry }): React.JSX.Element {
  const t = useTranslate()
  if (entry.state === 'signedIn') {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Check className="size-3" aria-hidden />
        {entry.method === 'apiKey'
          ? t('accounts.hostAgentSignIn.signedInApiKey', 'Signed in with an API key')
          : t('accounts.hostAgentSignIn.signedIn', 'Signed in')}
      </span>
    )
  }
  return (
    <span
      className={cn(
        'text-xs',
        entry.state === 'signedOut' ? 'text-status-warning' : 'text-muted-foreground'
      )}
    >
      {entry.state === 'signedOut'
        ? t('accounts.hostAgentSignIn.signedOut', 'Not signed in')
        : entry.state === 'notInstalled'
          ? t('accounts.hostAgentSignIn.notInstalled', 'Not installed on this host')
          : t('accounts.hostAgentSignIn.unknown', 'Couldn’t check')}
    </span>
  )
}

/** The agents' rows: status, one Sign in per agent, and the relayed prompt while it runs. */
export function HostAgentSignInRows({
  environmentId,
  hostLabel,
  view,
  runningAgent,
  errors,
  onSignIn,
  onRecheck
}: HostAgentSignInRowsProps): React.JSX.Element {
  const t = useTranslate()
  if (view.phase === 'asleep') {
    return (
      <p className="text-sm text-muted-foreground">
        {t(
          'accounts.hostAgentSignIn.asleep',
          '{{host}} is asleep. Open one of its workspaces to wake it, then check again.',
          { host: hostLabel }
        )}
      </p>
    )
  }
  if (view.phase === 'unsupported') {
    return (
      <p className="text-sm text-muted-foreground">
        {t(
          'accounts.hostAgentSignIn.unsupported',
          'Update Orca on {{host}} to sign in agents from here.',
          { host: hostLabel }
        )}
      </p>
    )
  }
  const report = 'report' in view ? view.report : null
  if (!report) {
    return view.phase === 'failed' ? (
      <div className="flex items-center justify-between gap-3">
        <p role="alert" className="text-sm text-destructive">
          {t('accounts.hostAgentSignIn.checkFailed', 'Couldn’t reach {{host}} to check agents.', {
            host: hostLabel
          })}
        </p>
        <Button type="button" variant="outline" size="xs" onClick={onRecheck}>
          {t('accounts.hostAgentSignIn.retry', 'Try again')}
        </Button>
      </div>
    ) : (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoadingSpinner className="size-3" />
        {t('accounts.hostAgentSignIn.checking', 'Checking agents on {{host}}…', {
          host: hostLabel
        })}
      </p>
    )
  }
  const owner = { kind: 'environment', environmentId } as const
  const entries = HOST_AGENT_SIGN_IN_AGENTS.map(
    (agent) =>
      report.agents.find((entry) => entry.agent === agent) ?? {
        agent,
        state: 'unknown' as const
      }
  )
  return (
    <div className="divide-y divide-border rounded-md border border-border">
      {entries.map((entry) => {
        const label = getAgentLabel(entry.agent)
        const error = errors[entry.agent]
        const running = runningAgent === entry.agent
        const canSignIn = entry.state === 'signedOut' || entry.state === 'unknown'
        return (
          <div key={entry.agent} className="space-y-2 px-3 py-2.5">
            <div className="flex items-center gap-3">
              <AgentIcon agent={entry.agent} size={16} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{label}</div>
                <StatusText entry={entry} />
              </div>
              {canSignIn && !running ? (
                <Button
                  type="button"
                  variant={entry.state === 'signedOut' ? 'default' : 'outline'}
                  size="xs"
                  disabled={runningAgent !== null}
                  onClick={() => onSignIn(entry.agent)}
                >
                  <LogIn />
                  {error
                    ? t('accounts.hostAgentSignIn.retry', 'Try again')
                    : t('accounts.hostAgentSignIn.signIn', 'Sign in')}
                </Button>
              ) : null}
            </div>
            {running ? (
              <HostAccountSignInPrompt owner={owner} provider={entry.agent} hostLabel={hostLabel} />
            ) : null}
            {error && !running ? (
              <div role="alert" className="space-y-1 text-xs">
                <p className="text-destructive">{error}</p>
                {entry.agent === 'codex' ? (
                  <p className="text-muted-foreground">
                    {t(
                      'accounts.hostAgentSignIn.codexDeviceCodeHint',
                      'Codex signs in with a device code. If it fails, turn on device code login in ChatGPT under Settings → Security, then try again.'
                    )}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function useRunningAgent(environmentId: string): HostAgentSignInAgent | null {
  const read = (): HostAgentSignInAgent | null => {
    for (const agent of HOST_AGENT_SIGN_IN_AGENTS) {
      const owner = runningHostAccountSignInOwner(agent)
      if (owner?.environmentId === environmentId) {
        return agent
      }
    }
    return null
  }
  return useSyncExternalStore(subscribeHostAccountSignIns, read, read)
}

function SignInDialogBody({ target }: { target: HostAgentSignInDialogTarget }): React.JSX.Element {
  const t = useTranslate()
  const { environmentId, hostLabel } = target
  const view = useHostAgentSignInView(environmentId, true)
  const runningAgent = useRunningAgent(environmentId)
  const [errors, setErrors] = useState<Partial<Record<HostAgentSignInAgent, string>>>({})
  const checking = view.phase === 'checking'
  const signIn = (agent: HostAgentSignInAgent): void => {
    setErrors((current) => ({ ...current, [agent]: undefined }))
    void signInAgentOnHost(environmentId, agent).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (!CANCELLED_MESSAGES.has(message)) {
        setErrors((current) => ({ ...current, [agent]: message }))
      }
    })
  }
  const recheck = (): void => void refreshHostAgentSignInStatus(environmentId, { force: true })
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('accounts.hostAgentSignIn.title', 'Sign in agents')}</DialogTitle>
        <DialogDescription>
          {t(
            'accounts.hostAgentSignIn.description',
            'Each agent signs in on {{host}}, and the login stays there. Orca only passes along the link and code.',
            { host: hostLabel }
          )}
        </DialogDescription>
      </DialogHeader>
      <HostAgentSignInRows
        environmentId={environmentId}
        hostLabel={hostLabel}
        view={view}
        runningAgent={runningAgent}
        errors={errors}
        onSignIn={signIn}
        onRecheck={recheck}
      />
      <p className="text-xs text-muted-foreground">
        {t(
          'accounts.hostAgentSignIn.apiKeyNote',
          'Using an API key instead? Set ANTHROPIC_API_KEY or OPENAI_API_KEY in that host’s shell profile.'
        )}
      </p>
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={checking || runningAgent !== null}
          onClick={recheck}
        >
          {checking ? <LoadingSpinner className="size-3" /> : <RefreshCw />}
          {t('accounts.hostAgentSignIn.recheck', 'Check again')}
        </Button>
        <Button type="button" size="sm" onClick={() => closeAndCancel(target)}>
          {t('accounts.hostAgentSignIn.done', 'Done')}
        </Button>
      </DialogFooter>
    </>
  )
}

/** Closing mid-sign-in cancels it, so no login is left waiting on the host for a code. */
function closeAndCancel(target: HostAgentSignInDialogTarget): void {
  const owner = { kind: 'environment', environmentId: target.environmentId } as const
  for (const agent of HOST_AGENT_SIGN_IN_AGENTS) {
    if (runningHostAccountSignInOwner(agent)?.environmentId === target.environmentId) {
      void cancelHostAccountSignIn(owner, agent).catch(() => {})
    }
  }
  closeHostAgentSignInDialog()
}

/** App-wide host for the "Sign in agents" step. */
export default function HostAgentSignInDialog(): React.JSX.Element | null {
  const target = useSyncExternalStore(
    subscribeHostAgentSignInDialog,
    readHostAgentSignInDialogTarget,
    readHostAgentSignInDialogTarget
  )
  if (!target) {
    return null
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          closeAndCancel(target)
        }
      }}
    >
      <DialogContent className="max-w-md">
        <SignInDialogBody key={target.environmentId} target={target} />
      </DialogContent>
    </Dialog>
  )
}
