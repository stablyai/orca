import React, { useEffect, useSyncExternalStore } from 'react'
import { Circle, CircleCheck, ExternalLink, Loader2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import {
  precheckHostAgentSignIn,
  readHostAgentSignInReport,
  subscribeHostAgentSignInReports
} from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import {
  HOST_AGENT_SIGN_IN_AGENTS,
  HOST_AGENT_SIGN_IN_AGENT_NAME,
  type HostAgentSignInAgent,
  type HostAgentSignInReport
} from '../../../../shared/host-agent-sign-in-status'
import {
  openSignInPage,
  useAgentSignInGate,
  type AgentSignInGate
} from '@/lib/agent-sign-in/agent-sign-in-gate'
import {
  cancelVmBuildAgentSignIn,
  forgetVmBuildSignedInAgent,
  startVmBuildAgentSignIn,
  useVmBuildAgentSignIn,
  type VmBuildAgentSignIn,
  type VmBuildSignedInAgent
} from '@/lib/agent-sign-in/vm-build-agent-sign-in'
import { switchHostAgentAccount } from '@/lib/agent-sign-in/host-agent-sign-out'
import { AgentSignInCard, ErrorLine } from '../agent-sign-in/AgentSignInCard'
import { agentSignInCardActions } from '../agent-sign-in/AgentSignInPanePortals'

const AGENT_NAME = HOST_AGENT_SIGN_IN_AGENT_NAME

export type VmBuildAgentSignInRowModel =
  | { kind: 'idle'; agents: readonly HostAgentSignInAgent[] }
  | {
      kind: 'busy'
      agent: HostAgentSignInAgent
      next: readonly HostAgentSignInAgent[]
      gate: AgentSignInGate | null
    }
  | { kind: 'done'; agents: readonly VmBuildSignedInAgent[] }

/** Hidden unless an agent on the VM is signed out, or the sheet already signed one in. */
export function deriveVmBuildAgentSignInRow(
  report: HostAgentSignInReport | null,
  run: VmBuildAgentSignIn | null,
  gate: AgentSignInGate | null
): VmBuildAgentSignInRowModel | null {
  if (run?.running && run.current) {
    return { kind: 'busy', agent: run.current, next: run.next, gate }
  }
  // The host's re-check after a sign-in can land after the run ends; trust the sign-in meanwhile.
  const signedOut = HOST_AGENT_SIGN_IN_AGENTS.filter(
    (agent) =>
      report?.agents.find((entry) => entry.agent === agent)?.state === 'signedOut' &&
      !run?.signedIn.some((entry) => entry.agent === agent)
  )
  if (signedOut.length > 0) {
    return { kind: 'idle', agents: signedOut }
  }
  return run && run.signedIn.length > 0 ? { kind: 'done', agents: run.signedIn } : null
}

export type VmBuildAgentSignInRowActions = {
  signIn: (agents: readonly HostAgentSignInAgent[]) => void
  cancel: () => void
  switchAccount: (agent: HostAgentSignInAgent) => void
}

/** The build checklist's optional sign-in row; the workspace opens whether or not it is used. */
export function VmBuildAgentSignInRowView({
  model,
  gateKey,
  actions
}: {
  model: VmBuildAgentSignInRowModel
  gateKey: string
  actions: VmBuildAgentSignInRowActions
}): React.JSX.Element {
  const t = useTranslate()
  const view = model.kind === 'busy' ? model.gate?.view : undefined
  // Steps that need more than one line (a code, an error) get the full sign-in card under the row.
  const cardStep =
    view && (view.step === 'paste' || view.step === 'device' || view.step === 'error')
  const otherAccounts =
    model.kind === 'done' ? model.agents.filter((entry) => entry.expectedEmail) : []

  let icon: React.ReactNode
  let tag: string | null = null
  let detail: string | null = null
  let meta: React.ReactNode = null
  if (model.kind === 'idle') {
    icon = <Circle aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" />
    tag = t('vmBuildAgentSignIn.optional', 'optional')
    detail = t('vmBuildAgentSignIn.idleDetail', 'Or sign in when you first start one.')
    meta = (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => actions.signIn(model.agents)}
      >
        {model.agents.length > 1
          ? t('vmBuildAgentSignIn.signInBoth', 'Sign in {{first}} + {{second}}', {
              first: AGENT_NAME[model.agents[0]],
              second: AGENT_NAME[model.agents[1]]
            })
          : t('vmBuildAgentSignIn.signInOne', 'Sign in {{agent}}', {
              agent: AGENT_NAME[model.agents[0]]
            })}
      </Button>
    )
  } else if (model.kind === 'busy') {
    const name = AGENT_NAME[model.agent]
    icon = <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
    tag =
      model.next.length > 0
        ? t('vmBuildAgentSignIn.next', '{{agent}} next', { agent: AGENT_NAME[model.next[0]] })
        : null
    detail =
      view?.step === 'waiting'
        ? t('vmBuildAgentSignIn.waiting', '{{agent}}: finish in your browser', { agent: name })
        : view?.step === 'signed'
          ? t('vmBuildAgentSignIn.signed', '{{agent}}: signed in', { agent: name })
          : cardStep
            ? t('vmBuildAgentSignIn.continueBelow', '{{agent}}: continue below', { agent: name })
            : t('vmBuildAgentSignIn.starting', '{{agent}}: starting sign-in…', { agent: name })
    // The card below carries its own Cancel.
    meta = cardStep ? null : (
      <>
        {view?.step === 'waiting' ? (
          <Button type="button" variant="ghost" size="xs" onClick={() => openSignInPage(view.url)}>
            <ExternalLink />
            {t('agentSignIn.openAgain', 'Open again')}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          onClick={actions.cancel}
        >
          {t('agentSignIn.cancel', 'Cancel')}
        </Button>
      </>
    )
  } else {
    icon = <CircleCheck aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    meta = (
      <span className="text-xs text-muted-foreground">
        {model.agents.map((entry) => AGENT_NAME[entry.agent]).join(', ')}
      </span>
    )
  }

  return (
    <li className="flex flex-col gap-2 py-1.5" data-vm-build-agent-sign-in={model.kind}>
      <div className="flex items-center gap-2.5">
        {icon}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">
            {t('vmBuildAgentSignIn.title', 'Agent sign-in')}
            {tag ? <span className="text-xs text-muted-foreground"> · {tag}</span> : null}
          </span>
          {detail ? <span className="truncate text-xs text-muted-foreground">{detail}</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">{meta}</div>
      </div>
      {otherAccounts.map((entry) => (
        <div key={entry.agent} className="flex flex-wrap items-center gap-2 pl-6">
          <div className="min-w-0 flex-1">
            <ErrorLine
              tone="warning"
              title={t('vmBuildAgentSignIn.otherAccount', '{{agent}} signed in as {{email}}.', {
                agent: AGENT_NAME[entry.agent],
                email: entry.email ?? ''
              })}
              detail={t(
                'agentSignIn.otherAccountDetail',
                'This computer uses {{email}} for {{agent}}.',
                { email: entry.expectedEmail ?? '', agent: AGENT_NAME[entry.agent] }
              )}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => actions.switchAccount(entry.agent)}
          >
            {t('agentSignIn.switchAccount', 'Switch account')}
          </Button>
        </div>
      ))}
      {cardStep && model.kind === 'busy' && model.gate ? (
        <div className="pl-6">
          <AgentSignInCard
            gate={model.gate}
            actions={{
              ...agentSignInCardActions(gateKey),
              cancel: actions.cancel,
              skip: undefined
            }}
          />
        </div>
      ) : null}
    </li>
  )
}

/** Live row for a VM create; asks the VM once which agents are signed in. */
export function VmBuildAgentSignInRow({
  creationId,
  environmentId
}: {
  creationId: string
  environmentId: string
}): React.JSX.Element | null {
  const report = useSyncExternalStore(subscribeHostAgentSignInReports, () =>
    readHostAgentSignInReport(environmentId)
  )
  const run = useVmBuildAgentSignIn(creationId, environmentId)
  const gateKey = run?.gateKey ?? ''
  const gate = useAgentSignInGate(gateKey)
  const hostLabel = useAppStore(
    (s) => s.runtimeEnvironments.find((environment) => environment.id === environmentId)?.name
  )
  useEffect(() => {
    precheckHostAgentSignIn(environmentId)
  }, [environmentId])
  const model = deriveVmBuildAgentSignInRow(report, run, gate)
  if (!model) {
    return null
  }
  const label = hostLabel ?? environmentId
  return (
    <VmBuildAgentSignInRowView
      model={model}
      gateKey={gateKey}
      actions={{
        signIn: (agents) => void startVmBuildAgentSignIn(creationId, environmentId, label, agents),
        cancel: () => cancelVmBuildAgentSignIn(creationId),
        switchAccount: (agent) =>
          void switchHostAgentAccount(environmentId, label, agent).then((switched) => {
            if (switched) {
              forgetVmBuildSignedInAgent(creationId, agent)
            }
          })
      }}
    />
  )
}
