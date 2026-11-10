// "Set up Orca Cloud": what still stands between this prompt and a running sandbox (spec A1/B1/C1).
// Shown when Orca Cloud is picked and anything required is missing; hidden once everything is done.
// The rows come from billing today and from the one-trip setup session once it exists.
import React from 'react'
import { Check, CircleDashed, CircleDot, Loader2 } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { CloudSetupStep, CloudSetupStepId } from './cloud-start-model'

type RowCopy = { title: string; detail: string | null }

function rowCopy(step: CloudSetupStep, t: Translate): RowCopy {
  switch (step.id) {
    case 'account':
      return {
        title: t('components.newWorkspace.cloudSetup.account', 'Orca account'),
        detail:
          step.state === 'done'
            ? null
            : t('components.newWorkspace.cloudSetup.accountNeeded', 'Sign in or create one')
      }
    case 'team':
      return { title: t('components.newWorkspace.cloudSetup.team', 'Team'), detail: null }
    case 'plan':
      return {
        title: t('components.newWorkspace.cloudSetup.plan', 'Team plan'),
        detail: planDetail(step, t)
      }
    case 'github':
      return {
        title: t('components.newWorkspace.cloudSetup.github', 'GitHub access'),
        detail:
          step.state === 'done'
            ? null
            : t(
                'components.newWorkspace.cloudSetup.githubNeeded',
                'Orca Cloud clones your code from GitHub. Give access to this repository once.'
              )
      }
    case 'agent':
      return {
        title: t('components.newWorkspace.cloudSetup.agent', 'Agent'),
        detail: t(
          'components.newWorkspace.cloudSetup.agentLater',
          'Sign in once the workspace starts'
        )
      }
  }
}

function planDetail(step: CloudSetupStep, t: Translate): string | null {
  if (step.state === 'pending') {
    return t('components.newWorkspace.cloudSetup.planAfterSignIn', 'Checked after you sign in')
  }
  if (step.state !== 'needed') {
    return null
  }
  const memberSuffix =
    step.canFix === false
      ? ` ${t('components.newWorkspace.cloudSetup.askOwner', 'Ask an owner or admin to fix it.')}`
      : ''
  switch (step.need) {
    case 'renew-plan':
      return (
        t('components.newWorkspace.cloudSetup.planEnded', 'Your Team plan ended.') + memberSuffix
      )
    case 'hours':
      return (
        t('components.newWorkspace.cloudSetup.outOfHours', 'Out of sandbox hours.') + memberSuffix
      )
    case 'spend-cap':
      return t('components.newWorkspace.cloudSetup.spendCap', 'Spend cap reached.') + memberSuffix
    case 'payment':
      return t('components.newWorkspace.cloudSetup.paymentFailed', 'Payment failed.') + memberSuffix
    default:
      return step.canFix === false
        ? t(
            'components.newWorkspace.cloudSetup.planMember',
            'Orca Cloud needs a Team plan. Only owners and admins can choose one.'
          )
        : t('components.newWorkspace.cloudSetup.planNeeded', 'Orca Cloud needs a Team plan.')
  }
}

function stateLabel(step: CloudSetupStep, t: Translate): string {
  switch (step.state) {
    case 'done':
      return t('components.newWorkspace.cloudSetup.stateDone', 'Done')
    case 'optional':
      return t('components.newWorkspace.cloudSetup.stateOptional', 'Optional')
    case 'pending':
      return t('components.newWorkspace.cloudSetup.stateNext', 'Next')
    case 'active':
      return t('components.newWorkspace.cloudSetup.stateInBrowser', 'In browser')
    case 'failed':
      return t('components.newWorkspace.cloudSetup.stateFailed', "Didn't finish")
    case 'loading':
      return t('components.newWorkspace.cloudSetup.stateChecking', 'Checking')
    case 'needed':
      return t('components.newWorkspace.cloudSetup.stateNeeded', 'Needed')
  }
}

function StateIcon({ step }: { step: CloudSetupStep }): React.JSX.Element {
  if (step.state === 'done') {
    return <Check className="size-3.5 text-status-success" aria-hidden />
  }
  if (step.state === 'active') {
    // The browser is working on this step; static under reduced motion, the label carries the state.
    return (
      <Loader2 className="size-3.5 text-muted-foreground motion-safe:animate-spin" aria-hidden />
    )
  }
  if (step.state === 'needed' || step.state === 'failed') {
    return <CircleDot className="size-3.5 text-status-warning-text" aria-hidden />
  }
  return <CircleDashed className="size-3.5 text-muted-foreground" aria-hidden />
}

export function OrcaCloudSetupPanel({
  steps,
  allSet = false,
  title,
  subtitle,
  children,
  rowActions,
  className
}: {
  steps: readonly CloudSetupStep[]
  /** Setup just finished: "All set", then the composer starts the workspace by itself. */
  allSet?: boolean
  /** Overrides for variants such as the "Finish in your browser" tracker. */
  title?: string
  subtitle?: string
  /** Rendered under the rows (tracker errors and actions). */
  children?: React.ReactNode
  /** Per-row slot under a row's detail, e.g. the member "Ask for a Team plan" action on 'plan'. */
  rowActions?: Partial<Record<CloudSetupStepId, React.ReactNode>>
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const titleId = React.useId()
  return (
    <section
      role="region"
      aria-labelledby={titleId}
      data-orca-cloud-setup-panel="true"
      className={cn('rounded-md border border-border bg-muted/30 px-3 py-2.5', className)}
    >
      <h3 id={titleId} className="text-xs font-medium text-foreground">
        {allSet
          ? t('components.newWorkspace.cloudSetup.allSet', 'All set')
          : (title ?? t('components.newWorkspace.cloudSetup.title', 'Set up Orca Cloud'))}
      </h3>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {allSet
          ? t('components.newWorkspace.cloudSetup.starting', 'Starting your cloud workspace…')
          : (subtitle ??
            t(
              'components.newWorkspace.cloudSetup.subtitle',
              'One visit to your browser. Your prompt stays here and starts when you’re done.'
            ))}
      </p>
      {/* One polite announcement per row change ("Team plan, done"). */}
      <ul aria-live="polite" className="mt-2 space-y-1.5">
        {steps.map((step) => {
          const copy = rowCopy(step, t)
          const state = stateLabel(step, t)
          return (
            <li
              key={step.id}
              data-setup-step={step.id}
              data-setup-state={step.state}
              className="flex items-start gap-2"
            >
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                <StateIcon step={step} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-foreground">{copy.title}</span>
                {step.state === 'loading' ? (
                  <Skeleton shape="small" className="mt-1 h-2.5 w-40" />
                ) : (step.detail ?? copy.detail) ? (
                  <span className="block text-[11px] text-muted-foreground">
                    {step.detail ?? copy.detail}
                  </span>
                ) : null}
                {rowActions?.[step.id] ?? null}
              </span>
              <span
                className={cn(
                  'shrink-0 text-[11px]',
                  step.state === 'needed' ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                <span className="sr-only">{`${copy.title}, `}</span>
                {state}
              </span>
            </li>
          )
        })}
      </ul>
      {children}
    </section>
  )
}
