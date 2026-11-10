// "Set up Orca Cloud": what still stands between this prompt and a running sandbox (spec A1/B1/C1).
// Shown when Orca Cloud is picked and anything required is missing; hidden once everything is done.
// The rows come from billing today and from the one-trip setup session once it exists.
import React from 'react'
import { Check, CircleDashed, CircleDot, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { CloudSetupStep, CloudSetupStepId } from './cloud-start-model'

type RowCopy = { title: string; detail: string | null; note?: string; status?: string }

function rowCopy(step: CloudSetupStep, t: Translate): RowCopy {
  switch (step.id) {
    case 'account':
      return {
        title: t('components.newWorkspace.cloudSetup.account', 'Orca account'),
        detail:
          step.state === 'done'
            ? null
            : t(
                'components.newWorkspace.cloudSetup.accountNeededTeam',
                'Sign in or create one. We’ll make a team for you.'
              )
      }
    case 'team':
      return { title: t('components.newWorkspace.cloudSetup.team', 'Team'), detail: null }
    case 'plan':
      return step.need === 'trial' ? trialCopy(step, t) : planCopy(step, t)
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
      // The composer names the agent in `detail`; it never asks for a per-sandbox sign-in (G).
      return {
        title: t('components.newWorkspace.cloudSetup.agent', 'Agent'),
        detail: null,
        status: t('components.newWorkspace.cloudSetup.stateOptional', 'Optional')
      }
  }
}

/** A1/B1: the one-time trial, counted from billing's offer, never a literal. */
function trialCopy(step: CloudSetupStep, t: Translate): RowCopy {
  const hours = step.trialSeconds ? Math.round((step.trialSeconds / 3600) * 10) / 10 : null
  return {
    title: t('components.newWorkspace.cloudSetup.trial', 'Trial'),
    detail:
      hours === null
        ? null
        : t('components.newWorkspace.cloudSetup.trialOffer', '{{hours}} sandbox hours to try Orca Cloud', {
            count: hours,
            hours: String(hours),
            defaultValue_one: '{{hours}} sandbox hour to try Orca Cloud'
          }),
    note: t(
      'components.newWorkspace.cloudSetup.trialNoCard',
      'No card needed. Nothing is charged until you choose a plan.'
    ),
    status: t('components.newWorkspace.cloudSetup.stateIncluded', 'Included')
  }
}

function planCopy(step: CloudSetupStep, t: Translate): RowCopy {
  if (step.need === 'trial-used-up' && step.state === 'needed') {
    // T2 / C1: neutral, nothing failed. Members read who can fix it.
    return {
      title: t('components.newWorkspace.cloudSetup.plan', 'Team plan'),
      detail: t('components.newWorkspace.cloudSetup.trialUsedUp', 'Your trial is used up.'),
      note:
        step.canFix === false
          ? t(
              'components.newWorkspace.cloudSetup.trialUsedUpMember',
              'Only owners and admins can choose a plan.'
            )
          : t(
              'components.newWorkspace.cloudSetup.trialUsedUpOwner',
              'Choose a plan to keep using Orca Cloud. Your prompt is still here.'
            )
    }
  }
  return {
    title: t('components.newWorkspace.cloudSetup.plan', 'Team plan'),
    detail: planDetail(step, t)
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
    case 'github':
      return t(
        'components.newWorkspace.cloudSetup.githubNeeded',
        'Orca Cloud clones your code from GitHub. Give access to this repository once.'
      )
    case 'sign-in':
    case 'plan':
    case 'trial':
    case 'trial-used-up':
    case undefined:
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
              'components.newWorkspace.cloudSetup.subtitleNoCard',
              'One visit to your browser, no card. Your prompt stays here and starts when you’re done.'
            ))}
      </p>
      {/* One polite announcement per row change ("Team plan, done"). */}
      <ul aria-live="polite" className="mt-2 space-y-1.5">
        {steps.map((step) => {
          const copy = rowCopy(step, t)
          const title = step.label ?? copy.title
          const state = step.status ?? copy.status ?? stateLabel(step, t)
          const note = step.note ?? copy.note
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
                <span className="block text-xs text-foreground">{title}</span>
                {step.state === 'loading' ? (
                  <Skeleton shape="small" className="mt-1 h-2.5 w-40" />
                ) : (step.detail ?? copy.detail) ? (
                  <span className="block text-[11px] text-muted-foreground">
                    {step.detail ?? copy.detail}
                  </span>
                ) : null}
                {note ? (
                  <span className="block text-[11px] text-muted-foreground">{note}</span>
                ) : null}
                {step.action ? (
                  <Button
                    type="button"
                    variant="link"
                    size="inline"
                    onClick={step.action.onClick}
                  >
                    {step.action.label}
                  </Button>
                ) : null}
                {rowActions?.[step.id] ?? null}
              </span>
              <span
                className={cn(
                  'shrink-0 text-[11px]',
                  step.state === 'needed' ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                <span className="sr-only">{`${title}, `}</span>
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
