// The code sign-in for a classic SSH host, under that agent's row (spec §4 annotation 5, Q8):
// Claude pastes the code from claude.ai, Codex enters a device code on auth.openai.com. The login
// runs on the host over SSH; this only shows the link and takes the code once.
import React, { useState } from 'react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import { Input } from '@/components/ui/input'
import { InlineError } from '@/components/ui/inline-error'
import { HOST_AGENT_SIGN_IN_AGENT_NAME } from '../../../../../shared/host-agent-sign-in-status'
import type {
  SshAgentSignInFlow,
  SshAgentSignInFlowError
} from '../../../../../shared/ssh-agent-sign-in-types'

export type SshCodeSignInActions = {
  submit: (flowId: string, code: string) => void
  cancel: (flowId: string) => void
  retry: (flow: SshAgentSignInFlow) => void
  openLink: (url: string) => void
  copyAndOpen: (code: string, url: string) => void
}

function errorCopy(
  error: SshAgentSignInFlowError | undefined,
  agent: string,
  host: string,
  t: Translate
): string {
  switch (error) {
    case 'disconnected':
      return t('agentHostPanel.ssh.errorDisconnected', '{{host}} disconnected during sign-in.', {
        host
      })
    case 'notInstalled':
      return t('agentHostPanel.ssh.errorNotInstalled', '{{agent}} isn’t installed on {{host}}.', {
        agent,
        host
      })
    case 'timeout':
      return t('agentHostPanel.ssh.errorTimeout', 'Sign-in timed out. Nothing was changed.')
    case 'rejected':
      return t(
        'agentHostPanel.ssh.errorRejected',
        '{{agent}} didn’t accept that code. Start again.',
        {
          agent
        }
      )
    case 'busy':
    case 'failed':
    case undefined:
      return t(
        'agentHostPanel.ssh.errorFailed',
        '{{agent}} couldn’t finish signing in. Nothing was changed.',
        {
          agent
        }
      )
  }
}

const GUARD = (t: Translate): string =>
  t('agentSignInStrip.deviceGuard', 'Only continue if you started this sign-in in Orca.')

export function SshCodeSignIn({
  flow,
  host,
  actions
}: {
  flow: SshAgentSignInFlow
  host: string
  actions: SshCodeSignInActions
}): React.JSX.Element | null {
  const t = useTranslate()
  const [code, setCode] = useState('')
  const agent = HOST_AGENT_SIGN_IN_AGENT_NAME[flow.agent]
  const cancel = (
    <Button type="button" variant="ghost" size="xs" onClick={() => actions.cancel(flow.flowId)}>
      {t('agentHostPanel.ssh.cancel', 'Cancel')}
    </Button>
  )
  switch (flow.phase) {
    case 'signedIn':
    case 'cancelled':
      return null
    case 'failed':
      return (
        <InlineError
          density="compact"
          title={errorCopy(flow.error, agent, host, t)}
          retryLabel={t('agentHostPanel.retry', 'Try again')}
          onRetry={() => actions.retry(flow)}
        />
      )
    case 'starting':
    case 'submitting':
      return (
        <div
          role="status"
          className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
        >
          <span>
            {flow.phase === 'starting'
              ? t('agentHostPanel.ssh.starting', 'Starting the {{agent}} sign-in on {{host}}…', {
                  agent,
                  host
                })
              : t('agentHostPanel.ssh.submitting', 'Checking the code on {{host}}…', { host })}
          </span>
          {cancel}
        </div>
      )
    case 'needsCode':
      return (
        <form
          className="flex flex-col gap-1.5"
          aria-label={t('agentHostPanel.ssh.pasteLabel', 'Sign in to {{agent}} on {{host}}', {
            agent,
            host
          })}
          onSubmit={(event) => {
            event.preventDefault()
            if (code.trim()) {
              actions.submit(flow.flowId, code.trim())
              setCode('')
            }
          }}
        >
          <p className="text-xs text-foreground">
            {t(
              'agentHostPanel.ssh.pasteStep',
              'Approve on claude.ai, then paste the code it shows. The sign-in is saved on {{host}}.',
              { host }
            )}
          </p>
          <p className="text-xs text-muted-foreground">{GUARD(t)}</p>
          <div className="flex items-center gap-1.5">
            {flow.url ? (
              <OpenExternalSplitButton
                link={flow.url}
                variant="outline"
                size="xs"
                onClick={() => flow.url && actions.openLink(flow.url)}
              >
                {t('agentHostPanel.ssh.openClaude', 'Open claude.ai')}
              </OpenExternalSplitButton>
            ) : (
              <Button type="button" variant="outline" size="xs" disabled>
                {t('agentHostPanel.ssh.openClaude', 'Open claude.ai')}
              </Button>
            )}
            <Input
              variant="code"
              autoComplete="off"
              spellCheck={false}
              aria-label={t('agentHostPanel.ssh.codeLabel', 'Code from claude.ai')}
              placeholder={t('agentHostPanel.ssh.codePlaceholder', 'Paste the code')}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className="h-7 min-w-0 flex-1"
            />
            <Button type="submit" size="xs">
              {t('agentSignInStrip.continue', 'Continue')}
            </Button>
            {cancel}
          </div>
        </form>
      )
    case 'device':
      return (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-foreground">
            {t(
              'agentHostPanel.ssh.deviceStep',
              'Enter this code on auth.openai.com. The sign-in is saved on {{host}}.',
              {
                host
              }
            )}
          </p>
          <p className="text-xs text-muted-foreground">{GUARD(t)}</p>
          <div className="flex items-center gap-1.5">
            <code className="shrink-0 select-all rounded bg-muted px-1.5 font-mono text-xs tracking-wider">
              {flow.userCode}
            </code>
            {flow.url ? (
              <OpenExternalSplitButton
                link={flow.url}
                size="xs"
                onClick={() =>
                  flow.userCode && flow.url && actions.copyAndOpen(flow.userCode, flow.url)
                }
              >
                {t('agentSignInStrip.copyAndOpen', 'Copy code and open')}
              </OpenExternalSplitButton>
            ) : (
              <Button type="button" size="xs" disabled>
                {t('agentSignInStrip.copyAndOpen', 'Copy code and open')}
              </Button>
            )}
            {cancel}
          </div>
        </div>
      )
  }
}
