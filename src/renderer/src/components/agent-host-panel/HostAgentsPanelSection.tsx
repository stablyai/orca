// Panel section 1 on hosts with their own login: each agent's verdict from the host, and Sign out…
// (moved here from the host ⋯ menu). Actions that need the host say why when it can't answer.
import React from 'react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { HOST_AGENT_SIGN_IN_AGENT_NAME } from '../../../../shared/host-agent-sign-in-status'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import { SettingsDisabledControlTooltip } from '../settings/form-controls/SettingsDisabledControlTooltip'
import { LoadingRows, PanelSection } from './cloud-sections/PanelSection'
import type { HostAgentPanelRow, HostAgentPanelState } from './host-agents-panel-model'
import type { SshAgentSignInFlow } from '../../../../shared/ssh-agent-sign-in-types'
import { SshCodeSignIn, type SshCodeSignInActions } from './ssh-classic/SshCodeSignIn'
import { apiKeyOverridesDetail } from '../settings/agent-accounts/overview/overview-copy'

export type HostAgentsPanelSectionProps = {
  title: string
  help: string
  host: string
  /** Null: this host kind can't report sign-ins yet (classic SSH). */
  rows: readonly HostAgentPanelRow[] | null
  checking: boolean
  failed: boolean
  /** "last checked Nov 9" while the host can't answer; null when live or never checked. */
  lastChecked: string | null
  signOut: boolean
  actionsDisabledReason: string | null
  onSignOut: (agent: HostAgentSignInAgent) => void
  onCheckAgain: () => void
  /** WSL: the account selected for this distro in Accounts, per agent (annotation 7). */
  accounts?: Partial<Record<HostAgentSignInAgent, string | null>>
  /** Classic SSH: code sign-in over remote exec, inline under the agent's row. */
  codeSignIn?: {
    flows: Partial<Record<HostAgentSignInAgent, SshAgentSignInFlow>>
    start: (agent: HostAgentSignInAgent) => void
    actions: SshCodeSignInActions
  }
}

const RUNNING: ReadonlySet<SshAgentSignInFlow['phase']> = new Set([
  'starting',
  'needsCode',
  'submitting',
  'device',
  'failed'
])

function stateLabel(state: HostAgentPanelState, t: Translate): string {
  switch (state) {
    case 'signedIn':
      return t('agentHostPanel.host.signedIn', 'Signed in')
    case 'apiKey':
      return t('agentHostPanel.host.apiKey', 'Signed in with an API key')
    case 'apiKeyOverrides':
      return t('agentHostPanel.host.apiKeyOverrides', 'API key overrides sign-in')
    case 'signedOut':
      return t('agentHostPanel.host.signedOut', 'Signed out')
    case 'notInstalled':
      return t('agentHostPanel.host.notInstalled', 'Not installed')
    case 'unknown':
      return t('agentHostPanel.host.unknown', 'Not checked yet')
  }
}

function SignOutButton({
  agent,
  reason,
  onSignOut
}: {
  agent: HostAgentSignInAgent
  reason: string | null
  onSignOut: (agent: HostAgentSignInAgent) => void
}): React.JSX.Element {
  const t = useTranslate()
  const reasonId = React.useId()
  const label = t('agentSignIn.signOutOf', 'Sign out of {{agent}}…', {
    agent: HOST_AGENT_SIGN_IN_AGENT_NAME[agent]
  })
  return (
    <SettingsDisabledControlTooltip reason={reason ?? undefined}>
      <Button
        type="button"
        variant="outline"
        size="xs"
        aria-label={label}
        aria-disabled={reason ? 'true' : undefined}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => (reason ? undefined : onSignOut(agent))}
      >
        {t('agentHostPanel.host.signOut', 'Sign out…')}
        {reason ? (
          <span id={reasonId} className="sr-only">
            {reason}
          </span>
        ) : null}
      </Button>
    </SettingsDisabledControlTooltip>
  )
}

/** One action that needs the host; disabled with its reason (keyboard-reachable) while it can't. */
function ActionButton({
  label,
  ariaLabel,
  reason,
  onClick
}: {
  label: string
  ariaLabel: string
  reason: string | null
  onClick: () => void
}): React.JSX.Element {
  const reasonId = React.useId()
  return (
    <SettingsDisabledControlTooltip reason={reason ?? undefined}>
      <Button
        type="button"
        variant="outline"
        size="xs"
        aria-label={ariaLabel}
        aria-disabled={reason ? 'true' : undefined}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => (reason ? undefined : onClick())}
      >
        {label}
        {reason ? (
          <span id={reasonId} className="sr-only">
            {reason}
          </span>
        ) : null}
      </Button>
    </SettingsDisabledControlTooltip>
  )
}

export function HostAgentsPanelSection(props: HostAgentsPanelSectionProps): React.JSX.Element {
  const t = useTranslate()
  const { rows, checking, failed, lastChecked, host } = props
  const announce = rows
    ? rows
        .map((row) => `${HOST_AGENT_SIGN_IN_AGENT_NAME[row.agent]} ${stateLabel(row.state, t)}.`)
        .join(' ')
    : ''
  return (
    <PanelSection title={props.title} help={props.help}>
      {rows === null ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'agentHostPanel.host.cantCheck',
            'Orca can’t check sign-ins on {{host}} yet. Start an agent in a workspace there to sign in.',
            { host }
          )}
        </p>
      ) : checking && rows.every((row) => row.state === 'unknown') ? (
        <LoadingRows />
      ) : (
        <>
          {failed ? (
            <InlineError
              tone="neutral"
              density="compact"
              title={t(
                'agentHostPanel.host.noAnswer',
                '{{host}} didn’t answer. It may run an older Orca.',
                { host }
              )}
              retryLabel={t('agentHostPanel.retry', 'Try again')}
              onRetry={props.onCheckAgain}
            />
          ) : null}
          <ul className="flex flex-col divide-y divide-border/60">
            {rows.map((row) => {
              const flow = props.codeSignIn?.flows[row.agent]
              const muted = checking
                ? t('agentHostPanel.host.checking', 'Checking…')
                : lastChecked
                  ? t('agentHostPanel.host.lastChecked', 'last checked {{date}}', {
                      date: lastChecked
                    })
                  : null
              return (
                <li
                  key={row.agent}
                  data-agent={row.agent}
                  className="grid grid-cols-[5rem_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5"
                >
                  <span className="text-sm text-foreground">
                    {HOST_AGENT_SIGN_IN_AGENT_NAME[row.agent]}
                  </span>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm text-foreground">
                      {[stateLabel(row.state, t), muted].filter(Boolean).join(' · ')}
                    </span>
                    {row.state === 'apiKeyOverrides' ? (
                      <span className="text-xs text-muted-foreground">
                        {apiKeyOverridesDetail(row.agent, t)}
                      </span>
                    ) : null}
                    {props.accounts?.[row.agent] ? (
                      <span className="break-words text-xs text-muted-foreground">
                        {t(
                          'agentHostPanel.host.selectedAccount',
                          'Account: {{name}} (selected in Accounts)',
                          { name: props.accounts[row.agent] }
                        )}
                      </span>
                    ) : null}
                    {row.state === 'signedOut' && !props.codeSignIn ? (
                      <span className="text-xs text-muted-foreground">
                        {t(
                          'agentHostPanel.host.signInHint',
                          'Start {{agent}} in a workspace on {{host}} to sign in.',
                          { agent: HOST_AGENT_SIGN_IN_AGENT_NAME[row.agent], host }
                        )}
                      </span>
                    ) : null}
                  </div>
                  {props.signOut && row.canSignOut ? (
                    <SignOutButton
                      agent={row.agent}
                      reason={props.actionsDisabledReason}
                      onSignOut={props.onSignOut}
                    />
                  ) : props.codeSignIn &&
                    row.state === 'signedOut' &&
                    !(flow && RUNNING.has(flow.phase)) ? (
                    <ActionButton
                      label={t('agentHostPanel.ssh.signIn', 'Sign in')}
                      ariaLabel={t(
                        'agentHostPanel.ssh.signInTo',
                        'Sign in to {{agent}} on {{host}}',
                        {
                          agent: HOST_AGENT_SIGN_IN_AGENT_NAME[row.agent],
                          host
                        }
                      )}
                      reason={props.actionsDisabledReason}
                      onClick={() => props.codeSignIn?.start(row.agent)}
                    />
                  ) : (
                    <span />
                  )}
                  {props.codeSignIn && flow && RUNNING.has(flow.phase) ? (
                    <div className="col-span-3 pt-2">
                      <SshCodeSignIn flow={flow} host={host} actions={props.codeSignIn.actions} />
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
          <span role="status" className="sr-only">
            {checking ? '' : announce}
          </span>
        </>
      )}
    </PanelSection>
  )
}
