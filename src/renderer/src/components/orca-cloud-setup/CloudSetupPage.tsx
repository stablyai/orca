// "Set up Orca Cloud" as a page (composer-redo). Start in the composer closes the dialog and opens
// this when the account isn't ready. One step at a time: the current step is the page; finished
// steps are ticks in the stepper. Browser hops only for sign-in, Stripe and GitHub. When every
// step is done, the saved prompt starts by itself.
import React from 'react'
import { ArrowLeft, Check, Copy, ExternalLink, LoaderCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import type {
  CloudSetupStep,
  CloudSetupStepId
} from '@/components/new-workspace/run-on/cloud-start-model'
import { CloudSetupErrorNotice } from '@/components/new-workspace/cloud-setup/CloudSetupErrorNotice'
import { currentStepCopy, doneStepCopy, stepLabel, type StepCopy } from './cloud-setup-page-copy'
import type { CloudSetupFlow } from './use-cloud-setup-flow'

export type CloudSetupPageProps = {
  flow: CloudSetupFlow
  projectName: string | null
  prompt: string
  agentLabel: string | null
  /** The agent the prompt starts with: its glyph sits before its name in the header line (NS-04). */
  agent?: TerminalAgent | null
  /** Back from the first step: Create workspace again, with the prompt, project and agent kept. */
  onBackToComposer: () => void
  /** The × in the corner: leave setup, keep the draft (nothing starts). */
  onExit: () => void
  /** "All set": shown for a moment before the workspace starts. */
  starting: boolean
  /** Setup finished while the page was hidden: "All set" waits for an explicit Start (RR-b). */
  heldForStart?: boolean
  onStart?: () => void
}

type StepState = 'done' | 'current' | 'todo'

function SetupStepper({
  steps,
  current,
  viewing,
  allDone,
  onView
}: {
  steps: readonly CloudSetupStep[]
  current: CloudSetupStep | null
  /** A finished step being revisited. */
  viewing: CloudSetupStepId | null
  allDone: boolean
  /** Revisit a finished step; null returns to the current one. */
  onView: (id: CloudSetupStepId | null) => void
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
        const shownHere = viewing ? viewing === step.id : state === 'current'
        const mark = (
          <>
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
                shownHere ? 'font-medium text-foreground' : 'text-muted-foreground'
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
          </>
        )
        // Finished steps (and the current one, to come back to it) open; future ones don't.
        const clickable =
          !allDone && (state === 'done' || (state === 'current' && viewing !== null))
        return (
          <li key={step.id} className="flex items-center gap-2" data-setup-page-step={step.id}>
            {index > 0 ? <span aria-hidden className="h-px w-6 bg-border" /> : null}
            {clickable ? (
              <button
                type="button"
                aria-current={shownHere ? 'step' : undefined}
                onClick={() => onView(state === 'current' ? null : step.id)}
                className="flex items-center gap-2 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
              >
                {mark}
              </button>
            ) : (
              <span
                className="flex items-center gap-2"
                aria-current={shownHere ? 'step' : undefined}
              >
                {mark}
              </span>
            )}
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
        {flow.signingIn ? (
          <Button type="button" variant="ghost" size="sm" onClick={flow.cancelSignIn}>
            {t('cloudSetupPage.cancelSignIn', 'Cancel')}
          </Button>
        ) : null}
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

function StepActions({
  flow,
  onStart
}: {
  flow: CloudSetupFlow
  /** Present while "All set" waits for Start (the page was hidden when setup finished). */
  onStart?: (() => void) | null
}): React.JSX.Element | null {
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
  if (flow.signingIn || (flow.inBrowser && inBrowserAction && !flow.error)) {
    return <BrowserWaiting flow={flow} />
  }
  const continueLabel = t('cloudSetupPage.continueInBrowser', 'Continue in browser')
  switch (flow.action) {
    case 'sign-in':
      return flow.signInDidNotFinish ? (
        <div className="flex flex-col items-start gap-3">
          <p role="status" className="text-sm text-muted-foreground">
            {t('cloudSetupPage.signIn.didNotFinish', 'Sign-in didn’t finish. Try again.')}
          </p>
          {browser(continueLabel, flow.continueInBrowser)}
        </div>
      ) : (
        browser(continueLabel, flow.continueInBrowser)
      )
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
      if (onStart) {
        return (
          // The one action left on a page the user came back to: focused, so Enter starts.
          <Button type="button" autoFocus onClick={onStart}>
            {t('cloudSetupPage.start', 'Start')}
          </Button>
        )
      }
      return (
        <span className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
          {t('cloudSetupPage.starting', 'Starting…')}
        </span>
      )
  }
}

function StepBody({ copy, checking }: { copy: StepCopy; checking: boolean }): React.JSX.Element {
  return (
    <>
      {checking ? (
        <Skeleton className="h-4 w-72" />
      ) : copy.lead ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{copy.lead}</p>
      ) : null}
      {copy.aside ? <p className="text-sm italic text-muted-foreground">{copy.aside}</p> : null}
      {copy.note ? <p className="text-xs text-muted-foreground">{copy.note}</p> : null}
    </>
  )
}

export function CloudSetupPage({
  flow,
  projectName,
  prompt,
  agentLabel,
  agent = null,
  onBackToComposer,
  onExit,
  starting,
  heldForStart = false,
  onStart
}: CloudSetupPageProps): React.JSX.Element {
  const t = useTranslate()
  const titleId = React.useId()
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  // A finished step opened from the stepper or Back; null shows the current step.
  const [viewing, setViewing] = React.useState<CloudSetupStepId | null>(null)
  // Every row reads done but hasn't held yet: still "Checking" until the layer says it's starting.
  const allSet = starting || heldForStart
  const shown: CloudSetupFlow = allSet
    ? { ...flow, action: 'done' }
    : flow.action === 'done'
      ? { ...flow, action: 'checking' }
      : flow
  const viewed = viewing && !starting ? flow.steps.find((step) => step.id === viewing) : undefined
  const copy: StepCopy = viewed ? doneStepCopy(viewed, t, agentLabel) : currentStepCopy(shown, t)

  // Back walks to the previous step; from the first it returns to Create workspace.
  const back = (): void => {
    const steps = flow.steps
    const from = viewing
      ? steps.findIndex((step) => step.id === viewing)
      : flow.current
        ? steps.findIndex((step) => step.id === flow.current?.id)
        : steps.length
    const previous = from > 0 ? steps[from - 1] : undefined
    if (previous && !starting) {
      setViewing(previous.id)
      return
    }
    // Leaving setup cancels a sign-in this page started (it must not finish behind the user).
    flow.abandon()
    onBackToComposer()
  }

  const exit = (): void => {
    flow.abandon()
    onExit()
  }

  // Each new step moves focus to its heading so screen readers hear the change once.
  const stepKey = `${viewing ?? shown.current?.id ?? 'done'}:${shown.action}`
  React.useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [stepKey])

  const context = [
    prompt.trim()
      ? t('cloudSetupPage.headerFor', 'Setting up Orca Cloud for {{name}}', { name: prompt.trim() })
      : t('cloudSetupPage.header', 'Setting up Orca Cloud'),
    projectName
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <section
      aria-labelledby={titleId}
      data-cloud-setup-page="true"
      className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-background scrollbar-sleek"
    >
      <div className="flex shrink-0 items-center gap-3 px-6 pt-5">
        <Button type="button" variant="ghost" size="sm" className="-ms-2" onClick={back}>
          <ArrowLeft aria-hidden />
          {t('cloudSetupPage.back', 'Back')}
        </Button>
        <span
          className="min-w-0 flex-1 truncate text-center text-xs text-muted-foreground"
          data-cloud-setup-context="true"
        >
          {context}
          {agentLabel ? (
            <>
              {' · '}
              {/* NS-04 (e): the agent's glyph, muted like the line (never the coloured mark). */}
              {agent ? (
                <span aria-hidden="true" className="me-1 inline-flex align-[-2px]">
                  <AgentIcon agent={agent} size={14} className="[&_path]:fill-current" />
                </span>
              ) : null}
              {agentLabel}
            </>
          ) : null}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('cloudSetupPage.exit', 'Exit setup')}
          title={t('cloudSetupPage.exit', 'Exit setup')}
          onClick={exit}
        >
          <X aria-hidden />
        </Button>
      </div>

      {/* The same optically-centred top offset on every step, so nothing jumps between them. */}
      <div className="mx-auto w-full max-w-xl px-8 pb-12 pt-[max(2rem,calc(22vh-3.5rem))]">
        <SetupStepper
          steps={flow.steps}
          current={flow.current}
          viewing={viewing}
          allDone={allSet}
          onView={setViewing}
        />

        <div className="mt-8 space-y-3">
          <h1
            ref={headingRef}
            id={titleId}
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight text-foreground outline-none"
          >
            {copy.title}
          </h1>
          <StepBody copy={copy} checking={!viewed && shown.action === 'checking'} />
        </div>

        {flow.error && !starting && !viewed ? (
          <CloudSetupErrorNotice
            error={flow.error}
            canManageBilling={flow.canManageBilling}
            onAction={(action) =>
              action === 'reopen-browser' ? flow.reopenBrowser() : flow.continueInBrowser()
            }
            className="mt-6"
          />
        ) : null}

        <div className="mt-6 flex justify-end">
          {viewed ? (
            <Button type="button" onClick={() => setViewing(null)}>
              {t('cloudSetupPage.continue', 'Continue')}
            </Button>
          ) : (
            <StepActions flow={shown} onStart={heldForStart ? onStart : null} />
          )}
        </div>
      </div>
    </section>
  )
}
