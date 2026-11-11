// "Set up Orca Cloud" as a page (composer-redo). Start in the composer closes the dialog and opens
// this when the account isn't ready. One step at a time: the current step is the page; finished
// steps are ticks in the stepper. Browser hops only for sign-in, Stripe and GitHub. When every
// step is done, the saved prompt starts by itself.
import React from 'react'
import { ArrowLeft, Check, Cloud, Copy, ExternalLink, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudSetupStep } from '@/components/new-workspace/run-on/cloud-start-model'
import { CloudSetupErrorNotice } from '@/components/new-workspace/cloud-setup/CloudSetupErrorNotice'
import { currentStepCopy, stepLabel } from './cloud-setup-page-copy'
import type { CloudSetupFlow } from './use-cloud-setup-flow'
import { openOrcaCloudAgentAccounts } from '@/components/new-workspace/OrcaCloudAgentSetupRow'

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
              {state === 'current' ? (
                <span className="size-1.5 rounded-full bg-focus-ring" />
              ) : null}
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
      // A failed payment is fixed in the billing portal (browser); hours and the cap in Settings.
      return flow.current?.need === 'payment' ? (
        browser(continueLabel, flow.fixBilling)
      ) : (
        <Button type="button" onClick={flow.fixBilling}>
          {t('cloudSetupPage.billing.openSettings', 'Open billing settings')}
        </Button>
      )
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
          <Button
            type="button"
            onClick={flow.current?.action?.onClick ?? openOrcaCloudAgentAccounts}
          >
            {flow.current?.action?.label ?? t('cloudSetupPage.agent.setUp', 'Set up once')}
          </Button>
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
  // Every row reads done but hasn't held yet: still "Checking" until the layer says it's starting.
  const shown: CloudSetupFlow = starting
    ? { ...flow, action: 'done' }
    : flow.action === 'done'
      ? { ...flow, action: 'checking' }
      : flow
  const copy = currentStepCopy(shown, t, agentLabel)
  // Each new step moves focus to its heading so screen readers hear the change once.
  const stepKey = `${shown.current?.id ?? 'done'}:${shown.action}`
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
          <SetupStepper steps={flow.steps} current={flow.current} allDone={starting} />
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
          {shown.action === 'checking' ? (
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
          <StepActions flow={shown} />
        </div>

        <div className="mt-12">
          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
            <div className="text-xs font-medium text-muted-foreground">
              {t('cloudSetupPage.startsAfter', 'Starts when setup is done')}
            </div>
            <div className="mt-1 truncate text-sm text-foreground">
              {prompt.trim() || t('cloudSetupPage.untitled', 'New cloud workspace')}
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
