// "Set up Orca Cloud" as a page (composer-redo). Start in the composer closes the dialog and opens
// this when the account isn't ready. One step at a time: the current step is the page; finished
// steps are ticks in the stepper. Browser hops only for sign-in, Stripe and GitHub. When every
// step is done, the saved prompt starts by itself.
import React from 'react'
import { ArrowLeft, Check, Cloud, Copy, ExternalLink, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { CloudSetupStep } from '@/components/new-workspace/run-on/cloud-start-model'
import { CloudSetupErrorNotice } from '@/components/new-workspace/cloud-setup/CloudSetupErrorNotice'
import { sessionDetailCopy } from '@/components/new-workspace/run-on/cloud-setup-session-copy'
import type { CloudSetupFlow } from './use-cloud-setup-flow'

export type CloudSetupPageProps = {
  flow: CloudSetupFlow
  projectName: string | null
  prompt: string
  agentLabel: string | null
  /** Back to the composer with the prompt, project and agent as they were. */
  onBack: () => void
  /** "All set": shown for a moment before the workspace starts. */
  starting: boolean
}

function stepLabel(step: CloudSetupStep, t: Translate): string {
  switch (step.id) {
    case 'account':
      return t('cloudSetupPage.step.account', 'Account')
    case 'team':
      return t('cloudSetupPage.step.team', 'Team')
    case 'plan':
      return step.need === 'trial'
        ? t('cloudSetupPage.step.trial', 'Trial')
        : t('cloudSetupPage.step.plan', 'Plan')
    case 'github':
      return t('cloudSetupPage.step.github', 'GitHub')
    case 'agent':
      return t('cloudSetupPage.step.agent', 'Agent')
  }
}

type StepState = 'done' | 'current' | 'todo'

function SetupStepper({
  steps,
  current,
  allDone
}: {
  steps: readonly CloudSetupStep[]
  current: CloudSetupStep | null
  allDone: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const currentIndex = current ? steps.findIndex((step) => step.id === current.id) : steps.length
  return (
    <ol
      aria-label={t('cloudSetupPage.stepsLabel', 'Setup steps')}
      className="flex flex-wrap items-center gap-x-2 gap-y-2"
    >
      {steps.map((step, index) => {
        const state: StepState =
          allDone || index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo'
        const label = stepLabel(step, t)
        return (
          <li key={step.id} className="flex items-center gap-2" data-setup-page-step={step.id}>
            {index > 0 ? <span aria-hidden className="h-px w-6 bg-border" /> : null}
            <span
              aria-hidden
              className={cn(
                'flex size-4 shrink-0 items-center justify-center rounded-full',
                state === 'done' && 'bg-foreground text-background',
                state === 'current' && 'border-2 border-focus-ring',
                state === 'todo' && 'border border-border'
              )}
            >
              {state === 'done' ? <Check className="size-2.5" strokeWidth={3} /> : null}
              {state === 'current' ? <span className="size-1.5 rounded-full bg-focus-ring" /> : null}
            </span>
            <span
              className={cn(
                'text-xs',
                state === 'current' ? 'font-medium text-foreground' : 'text-muted-foreground'
              )}
            >
              {label}
              <span className="sr-only">
                {state === 'done'
                  ? `, ${t('cloudSetupPage.stepDone', 'done')}`
                  : state === 'current'
                    ? `, ${t('cloudSetupPage.stepCurrent', 'current step')}`
                    : ''}
              </span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

type StepCopy = { title: string; lead: string | null; note?: string | null }

function trialHours(step: CloudSetupStep): string | null {
  return step.trialSeconds ? String(Math.round((step.trialSeconds / 3600) * 10) / 10) : null
}

function currentStepCopy(flow: CloudSetupFlow, t: Translate, agentLabel: string | null): StepCopy {
  const step = flow.current
  const detail = step
    ? (sessionDetailCopy(step, t) === undefined ? step.detail : sessionDetailCopy(step, t)) ?? null
    : null
  switch (flow.action) {
    case 'sign-in':
      return {
        title: t('cloudSetupPage.signIn.title', 'Sign in to Orca'),
        lead: t(
          'cloudSetupPage.signIn.lead',
          'Orca Cloud runs your agents in a cloud workspace, so they keep going with your laptop closed. Sign in or create an account in your browser. We’ll make a team for you.'
        ),
        note: t(
          'cloudSetupPage.signIn.note',
          'New teams get a trial with no card needed. This page picks up each step on its own.'
        )
      }
    case 'start-trial': {
      const hours = step ? trialHours(step) : null
      return {
        title: t('cloudSetupPage.trial.title', 'Start your free trial'),
        lead:
          hours === null
            ? t('cloudSetupPage.trial.leadNoHours', 'Try Orca Cloud on your team. No card needed.')
            : t('cloudSetupPage.trial.lead', '{{hours}} sandbox hours to try Orca Cloud. No card needed.', {
                hours
              }),
        note: t('cloudSetupPage.trial.note', 'Nothing is charged until you choose a plan.')
      }
    }
    case 'choose-plan':
      return step?.need === 'trial-used-up'
        ? {
            title: t('cloudSetupPage.plan.trialUsedUpTitle', 'Your trial is used up'),
            lead: t(
              'cloudSetupPage.plan.trialUsedUpLead',
              'Choose a Team plan to keep using Orca Cloud. Checkout opens in your browser.'
            )
          }
        : step?.need === 'renew-plan'
          ? {
              title: t('cloudSetupPage.plan.renewTitle', 'Renew your Team plan'),
              lead: t(
                'cloudSetupPage.plan.renewLead',
                'Your Team plan ended. Renew it in your browser to start this workspace.'
              )
            }
          : {
              title: t('cloudSetupPage.plan.title', 'Choose a Team plan'),
              lead: t(
                'cloudSetupPage.plan.lead',
                'Orca Cloud needs a Team plan. Checkout opens in your browser.'
              )
            }
    case 'fix-billing':
      return {
        title:
          step?.need === 'payment'
            ? t('cloudSetupPage.billing.paymentTitle', 'Update your payment method')
            : step?.need === 'spend-cap'
              ? t('cloudSetupPage.billing.capTitle', 'Spend cap reached')
              : t('cloudSetupPage.billing.hoursTitle', 'Out of sandbox hours'),
        lead:
          step?.need === 'payment'
            ? t('cloudSetupPage.billing.paymentLead', 'The last payment failed. Update the card to keep going.')
            : step?.need === 'spend-cap'
              ? t('cloudSetupPage.billing.capLead', 'Raise the spend cap to start this workspace.')
              : t('cloudSetupPage.billing.hoursLead', 'Turn on overage to start this workspace.')
      }
    case 'switch-team':
      return { title: t('cloudSetupPage.team.title', 'Switch to your team'), lead: detail }
    case 'github-install':
      return {
        title: t('cloudSetupPage.github.title', 'Give Orca Cloud access on GitHub'),
        lead: t(
          'cloudSetupPage.github.lead',
          'Orca Cloud clones your code from GitHub. Install the Orca Cloud app on this repository once.'
        ),
        note: step?.note ?? null
      }
    case 'github-waiting':
      return {
        title: t('cloudSetupPage.github.waitingTitle', 'Waiting for approval on GitHub'),
        lead: detail,
        note: step?.note ?? null
      }
    case 'needs-repository':
      return {
        title: t('cloudSetupPage.repository.title', 'Orca Cloud needs a GitHub repository'),
        lead: detail,
        note: step?.note ?? null
      }
    case 'ask-owner':
      return {
        title: t('cloudSetupPage.owner.title', 'An owner or admin needs to fix this'),
        lead: detail ?? t('cloudSetupPage.owner.lead', 'Orca Cloud needs a Team plan. Only owners and admins can choose one.')
      }
    case 'agent':
      return {
        title: agentLabel
          ? t('cloudSetupPage.agent.title', 'Sign in to {{agent}} once', { agent: agentLabel })
          : t('cloudSetupPage.agent.titleGeneric', 'Sign in to your agent once'),
        lead: t(
          'cloudSetupPage.agent.lead',
          'Save your agent sign-in to your Orca account and every cloud workspace uses it. You can also skip this and sign in inside the workspace.'
        )
      }
    case 'checking':
      return { title: t('cloudSetupPage.checking.title', 'Checking your Orca Cloud account…'), lead: null }
    case 'done':
      return {
        title: t('cloudSetupPage.done.title', 'All set'),
        lead: t('cloudSetupPage.done.lead', 'Starting your cloud workspace…')
      }
  }
}

function BrowserWaiting({ flow }: { flow: CloudSetupFlow }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-wrap items-center gap-2" role="status">
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
        {t('cloudSetupPage.waitingBrowser', 'Waiting for your browser…')}
      </span>
      <span className="ms-auto flex items-center gap-2">
        {flow.copyLink ? (
          <Button type="button" variant="ghost" size="sm" onClick={flow.copyLink}>
            <Copy aria-hidden />
            {t('cloudSetupPage.copyLink', 'Copy link')}
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={flow.reopenBrowser}>
          {t('cloudSetupPage.reopenBrowser', 'Reopen browser')}
          <ExternalLink aria-hidden />
        </Button>
      </span>
    </div>
  )
}

function StepActions({ flow }: { flow: CloudSetupFlow }): React.JSX.Element | null {
  const t = useTranslate()
  const browser = (label: string, onClick: () => void): React.JSX.Element => (
    <Button type="button" onClick={onClick} disabled={flow.busy}>
      {flow.busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
      {label}
      <ExternalLink aria-hidden />
    </Button>
  )
  const inBrowserAction =
    flow.action === 'sign-in' ||
    flow.action === 'choose-plan' ||
    flow.action === 'fix-billing' ||
    flow.action === 'github-install'
  if (flow.inBrowser && inBrowserAction && !flow.error) {
    return <BrowserWaiting flow={flow} />
  }
  const continueLabel = t('cloudSetupPage.continueInBrowser', 'Continue in browser')
  switch (flow.action) {
    case 'sign-in':
    case 'choose-plan':
      return browser(continueLabel, flow.continueInBrowser)
    case 'fix-billing':
      return browser(continueLabel, flow.fixBilling)
    case 'github-install':
      return browser(continueLabel, flow.installGitHub)
    case 'start-trial':
      return (
        <Button type="button" onClick={flow.startTrial} disabled={flow.busy}>
          {flow.busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
          {t('cloudSetupPage.trial.start', 'Start free trial')}
        </Button>
      )
    case 'switch-team':
      return <div>{flow.teamAction}</div>
    case 'agent':
      return (
        <div className="flex flex-wrap items-center gap-2">
          {flow.current?.action ? (
            <Button type="button" onClick={flow.current.action.onClick}>
              {flow.current.action.label}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={flow.skipAgent}>
            {t('cloudSetupPage.agent.skip', 'Skip for now')}
          </Button>
        </div>
      )
    case 'needs-repository':
      return flow.current?.action ? (
        <Button type="button" variant="outline" onClick={flow.current.action.onClick}>
          {flow.current.action.label}
          <ExternalLink aria-hidden />
        </Button>
      ) : null
    case 'ask-owner':
      return (
        <Button type="button" variant="outline" onClick={flow.checkAgain}>
          {t('cloudSetupPage.checkAgain', 'Check again')}
        </Button>
      )
    case 'github-waiting':
      return (
        <span className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
          {t('cloudSetupPage.github.waiting', 'This page starts the workspace once they approve.')}
        </span>
      )
    case 'checking':
      return <Skeleton className="h-9 w-40" />
    case 'done':
      return (
        <span className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
          {t('cloudSetupPage.starting', 'Starting…')}
        </span>
      )
  }
}

export function CloudSetupPage({
  flow,
  projectName,
  prompt,
  agentLabel,
  onBack,
  starting
}: CloudSetupPageProps): React.JSX.Element {
  const t = useTranslate()
  const titleId = React.useId()
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  const copy = currentStepCopy(starting ? { ...flow, action: 'done' } : flow, t, agentLabel)
  // Each new step moves focus to its heading so screen readers hear the change once.
  const stepKey = starting ? 'done' : `${flow.current?.id ?? 'done'}:${flow.action}`
  React.useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [stepKey])
  return (
    <section
      aria-labelledby={titleId}
      data-cloud-setup-page="true"
      className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-background scrollbar-sleek"
    >
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-8 pb-12 pt-10">
        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="ghost" size="sm" className="-ms-2" onClick={onBack}>
            <ArrowLeft aria-hidden />
            {t('cloudSetupPage.back', 'Back')}
          </Button>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Cloud className="size-3.5" aria-hidden />
            {t('cloudSetupPage.eyebrow', 'Orca Cloud setup')}
          </span>
        </div>

        <div className="mt-8">
          <SetupStepper steps={flow.steps} current={flow.current} allDone={starting || flow.action === 'done'} />
        </div>

        <div className="mt-8 space-y-3">
          <h1
            ref={headingRef}
            id={titleId}
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight text-foreground outline-none"
          >
            {copy.title}
          </h1>
          {flow.action === 'checking' && !starting ? (
            <Skeleton className="h-4 w-72" />
          ) : copy.lead ? (
            <p className="text-sm leading-relaxed text-muted-foreground">{copy.lead}</p>
          ) : null}
          {copy.note ? <p className="text-xs text-muted-foreground">{copy.note}</p> : null}
        </div>

        {flow.error && !starting ? (
          <CloudSetupErrorNotice
            error={flow.error}
            canManageBilling={flow.canManageBilling}
            onAction={(action) =>
              action === 'reopen-browser' ? flow.reopenBrowser() : flow.continueInBrowser()
            }
            className="mt-6"
          />
        ) : null}

        <div className="mt-6">
          <StepActions flow={starting ? { ...flow, action: 'done' } : flow} />
        </div>

        <div className="mt-auto pt-12">
          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
            <div className="text-xs font-medium text-muted-foreground">
              {t('cloudSetupPage.startsAfter', 'Starts when setup is done')}
            </div>
            <div className="mt-1 truncate text-sm text-foreground">
              {prompt.trim() ||
                t('cloudSetupPage.untitled', 'New cloud workspace')}
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {[projectName, agentLabel, t('cloudSetupPage.orcaCloud', 'Orca Cloud')]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
