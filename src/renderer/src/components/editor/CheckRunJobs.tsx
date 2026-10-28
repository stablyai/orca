import React from 'react'
import { CheckCircle2, ChevronDown, CircleDashed, MinusCircle, XCircle } from 'lucide-react'
import { CheckJobLogTail } from '@/components/right-sidebar/check-job-log-tail'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { PRCheckJob, PRCheckStep } from '../../../../shared/github/check-types'
import {
  resolveStepOutcome,
  summarizeJobSteps,
  type StepOutcome
} from '../../../../shared/pr-check-step-status'
import { formatJobsForClipboard } from './check-run-clipboard-text'
import { CheckRunCopyButton } from './CheckRunCopyButton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import { checkJobIdentities, checkReadingStepsKey } from './check-details-reading-cache'
import type { CheckDetailsReadingOwner } from './check-details-reading-owner'

function StepOutcomeIcon({ outcome }: { outcome: StepOutcome }): React.JSX.Element {
  switch (outcome) {
    case 'success':
      return <CheckCircle2 className="size-3.5 shrink-0 text-status-success" />
    case 'failure':
      return <XCircle className="size-3.5 shrink-0 text-destructive" />
    case 'skipped':
      return <MinusCircle className="size-3.5 shrink-0 text-muted-foreground/60" />
    case 'pending':
      return <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" />
  }
}

function StepRow({ step }: { step: PRCheckStep }): React.JSX.Element {
  const outcome = resolveStepOutcome(step)
  return (
    <div className="flex min-w-0 items-center gap-2 py-1 text-xs">
      <StepOutcomeIcon outcome={outcome} />
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          outcome === 'skipped' ? 'text-muted-foreground' : 'text-foreground'
        )}
      >
        {step.name}
      </span>
      <span className="shrink-0 text-muted-foreground">{step.conclusion ?? step.status}</span>
    </div>
  )
}

function OtherJobSteps({
  steps,
  summary,
  failed,
  identity,
  owner
}: {
  steps: PRCheckStep[]
  summary: string
  failed: boolean
  identity: string
  owner?: CheckDetailsReadingOwner
}): React.JSX.Element {
  const cacheKey = owner ? checkReadingStepsKey(owner.key, identity, failed) : undefined
  const [open, setOpen] = React.useState(() => {
    const saved = cacheKey ? scrollTopCache.get(cacheKey) : undefined
    return saved === undefined ? !failed : saved === 1
  })
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        if (owner && !owner.currentSteps(identity, failed)) {
          return
        }
        owner?.cancel(identity)
        if (owner?.current() && cacheKey) {
          setWithLRU(scrollTopCache, cacheKey, next ? 1 : 0)
        }
        setOpen(next)
      }}
      className="mt-1"
    >
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="xs" className="w-full justify-start">
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
              !open && '-rotate-90'
            )}
          />
          <span>{summary}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent animation="height">
        <div className="mt-0.5 grid gap-0.5 pl-5">
          {steps.map((step) => (
            <StepRow key={step.name} step={step} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function JobCard({
  job,
  identity,
  owner
}: {
  job: PRCheckJob
  identity: string
  owner?: CheckDetailsReadingOwner
}): React.JSX.Element {
  const breakdown = summarizeJobSteps(job)
  const jobFailed = resolveStepOutcome(job) === 'failure'
  const collapsible = [...breakdown.succeeded, ...breakdown.skipped, ...breakdown.pending]
  const summaryParts: string[] = []
  if (breakdown.succeeded.length > 0) {
    summaryParts.push(
      `${breakdown.succeeded.length} ${translate(
        'auto.components.editor.CheckRunJobs.1c0a4d7e02',
        'succeeded'
      )}`
    )
  }
  if (breakdown.skipped.length > 0) {
    summaryParts.push(
      `${breakdown.skipped.length} ${translate(
        'auto.components.editor.CheckRunJobs.2d3b8f1a55',
        'skipped'
      )}`
    )
  }
  if (breakdown.pending.length > 0) {
    summaryParts.push(
      `${breakdown.pending.length} ${translate(
        'auto.components.editor.CheckRunJobs.3e6c9a2b71',
        'pending'
      )}`
    )
  }

  return (
    <div className="px-3 py-3">
      <div className="flex min-w-0 items-center gap-2">
        {jobFailed ? (
          <XCircle className="size-4 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="size-4 shrink-0 text-status-success" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {job.name}
        </span>
        {breakdown.failed.length > 0 && (
          <Badge variant="destructive">
            {breakdown.failed.length}
            {' / '}
            {breakdown.total}{' '}
            {translate('auto.components.editor.CheckRunJobs.4f7d0c3e88', 'steps failed')}
          </Badge>
        )}
      </div>

      {breakdown.failed.length > 0 && (
        <div className="mt-2 grid gap-0.5">
          {breakdown.failed.map((step) => (
            <StepRow key={step.name} step={step} />
          ))}
        </div>
      )}

      <CheckJobLogTail
        job={job}
        surface="details"
        jobIdentity={identity}
        expanded={jobFailed}
        positionOwner={owner}
      />
      {collapsible.length > 0 && (
        <OtherJobSteps
          key={JSON.stringify([identity, jobFailed])}
          steps={collapsible}
          failed={jobFailed}
          identity={identity}
          owner={owner}
          summary={summaryParts.join(
            translate('auto.components.editor.CheckRunJobs.5a8e1d4f23', ' · ')
          )}
        />
      )}
    </div>
  )
}

export function CheckRunJobs({
  jobs,
  hasFailedJobs,
  positionOwner
}: {
  jobs: PRCheckJob[]
  hasFailedJobs: boolean
  positionOwner?: CheckDetailsReadingOwner
}): React.JSX.Element {
  const entries = checkJobIdentities(jobs)
  const visible = hasFailedJobs
    ? entries.filter(({ job }) => resolveStepOutcome(job) === 'failure')
    : entries
  const clipboardText = formatJobsForClipboard(
    visible.map(({ job }) => job),
    translate('auto.components.editor.CheckRunDetailsPanel.ee07b33924', 'unknown')
  )

  return (
    <section className="min-w-0 rounded-md border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="text-sm font-medium">
          {hasFailedJobs
            ? translate('auto.components.editor.CheckRunDetailsPanel.066fedd446', 'Failed jobs')
            : translate('auto.components.editor.CheckRunDetailsPanel.49731703ea', 'Jobs')}
        </div>
        <CheckRunCopyButton
          text={clipboardText}
          label={translate('auto.components.editor.CheckRunJobs.copy', 'Copy jobs')}
        />
      </div>
      <div className="divide-y divide-border/50">
        {visible.map(({ job, identity }) => (
          <JobCard key={identity} job={job} identity={identity} owner={positionOwner} />
        ))}
      </div>
    </section>
  )
}
