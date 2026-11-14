import { completedDurationSeconds } from '../../../../../../shared/github/actions/actions-duration'
import { formatNativeChatDuration } from '../../../../../../shared/native-chat/transcript/turns/native-chat-turn-status'
import { actionsUrl } from '../../../../../../shared/github/actions/actions-web-url'
import { ActionsStatus } from '@/components/right-sidebar/actions/ActionsStatus'
import React from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  MinusCircle,
  XCircle
} from 'lucide-react'
import { isGitLabAllowedFailureJob } from '@/components/github/pr-check-presentation'
import { CHECK_COLOR } from '@/components/right-sidebar/checks-panel/presentation/check-presentation'
import { CheckJobLogTail } from '@/components/right-sidebar/checks-panel/logs/check-job-log-tail'
import { getIntlLocale } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type {
  PRCheckDetail,
  PRCheckJob,
  PRCheckStep
} from '../../../../../../shared/github/checks/check-types'
import {
  resolveStepOutcome,
  summarizeJobSteps,
  type StepOutcome
} from '../../../../../../shared/source-control/checks/pr-check-step-status'
import { formatJobsForClipboard } from '../actions/check-run-clipboard-text'
import { CheckRunCopyButton } from './CheckRunCopyButton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  scrollTopCache,
  setWithLRU
} from '@/components/editor/model-lifetime/retention/editor-view-state-cache'
import { checkJobIdentities, checkReadingStepsKey } from '../reading/check-details-reading-cache'
import type { CheckDetailsReadingOwner } from '../reading/check-details-reading-owner'

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

function StepRow({
  step,
  actionsStatusColors
}: {
  step: PRCheckStep
  actionsStatusColors: boolean
}): React.JSX.Element {
  const duration = completedDurationSeconds(step.startedAt, step.completedAt)
  const outcome = resolveStepOutcome(step)
  return (
    <div className="flex min-w-0 items-center gap-2 py-1 text-xs">
      {actionsStatusColors ? (
        <ActionsStatus status={step.conclusion ?? step.status} iconOnly />
      ) : (
        <StepOutcomeIcon outcome={outcome} />
      )}
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          outcome === 'skipped' ? 'text-muted-foreground' : 'text-foreground'
        )}
      >
        {step.name}
      </span>
      {duration !== null && (
        <span className="shrink-0 text-muted-foreground">{formatNativeChatDuration(duration)}</span>
      )}
      {actionsStatusColors ? (
        <ActionsStatus status={step.conclusion ?? step.status} showIcon={false} />
      ) : (
        <span className="shrink-0 text-muted-foreground">{step.conclusion ?? step.status}</span>
      )}
    </div>
  )
}

function OtherJobSteps({
  steps,
  summary,
  failed,
  identity,
  owner,
  actionsStatusColors
}: {
  steps: PRCheckStep[]
  summary: string
  failed: boolean
  identity: string
  owner?: CheckDetailsReadingOwner
  actionsStatusColors: boolean
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
            <StepRow key={step.name} step={step} actionsStatusColors={actionsStatusColors} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function JobCard({
  check,
  job,
  jobLinkLabel,
  identity,
  owner,
  actionsStatusColors
}: {
  check?: PRCheckDetail
  job: PRCheckJob
  jobLinkLabel: string
  identity: string
  owner?: CheckDetailsReadingOwner
  actionsStatusColors: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const duration = completedDurationSeconds(job.startedAt, job.completedAt)
  const breakdown = summarizeJobSteps(job)
  const jobFailed = resolveStepOutcome(job) === 'failure'
  const collapsible = [...breakdown.succeeded, ...breakdown.skipped, ...breakdown.pending]
  const summaryParts: string[] = []
  if (breakdown.succeeded.length > 0) {
    const count = breakdown.succeeded.length
    summaryParts.push(
      t('auto.components.editor.CheckRunJobs.stepsSucceeded', '{{count}} succeeded', {
        count,
        defaultValue_one: '{{count}} succeeded'
      })
    )
  }
  if (breakdown.skipped.length > 0) {
    const count = breakdown.skipped.length
    summaryParts.push(
      t('auto.components.editor.CheckRunJobs.stepsSkipped', '{{count}} skipped', {
        count,
        defaultValue_one: '{{count}} skipped'
      })
    )
  }
  if (breakdown.pending.length > 0) {
    const count = breakdown.pending.length
    summaryParts.push(
      t('auto.components.editor.CheckRunJobs.stepsPending', '{{count}} pending', {
        count,
        defaultValue_one: '{{count}} pending'
      })
    )
  }

  return (
    <div className="px-3 py-3">
      <div className="flex min-w-0 items-center gap-2">
        {actionsStatusColors ? (
          <ActionsStatus status={job.conclusion ?? job.status} iconOnly />
        ) : check && isGitLabAllowedFailureJob(check, job) ? (
          <AlertTriangle className={cn('size-4 shrink-0', CHECK_COLOR.gitlabAllowedFailure)} />
        ) : jobFailed ? (
          <XCircle className="size-4 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="size-4 shrink-0 text-status-success" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {job.name}
        </span>
        {breakdown.failed.length > 0 && (
          <Badge variant="destructive">
            {t(
              'auto.components.editor.CheckRunJobs.stepsFailedOfTotal',
              '{{failed}} / {{count}} steps failed',
              {
                failed: breakdown.failed.length,
                count: breakdown.total,
                defaultValue_one: '{{failed}} / {{count}} steps failed'
              }
            )}
          </Badge>
        )}
      </div>

      {actionsStatusColors && (job.runnerName || job.runnerLabels?.length) ? (
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {t('actions.runner', 'Runner')}:{' '}
          {[job.runnerName, ...(job.runnerLabels ?? [])].filter(Boolean).join(' · ')}
        </p>
      ) : null}

      {breakdown.failed.length > 0 && (
        <div className="mt-2 grid gap-0.5">
          {breakdown.failed.map((step) => (
            <StepRow key={step.name} step={step} actionsStatusColors={actionsStatusColors} />
          ))}
        </div>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {actionsStatusColors ? (
          <ActionsStatus status={job.conclusion ?? job.status} showIcon={false} />
        ) : (
          <span>{job.conclusion ?? job.status}</span>
        )}
        {job.startedAt && <span>{new Date(job.startedAt).toLocaleString(getIntlLocale())}</span>}
        {duration !== null && <span>{formatNativeChatDuration(duration)}</span>}
        {actionsUrl(job.url) && (
          <Button variant="link" size="xs" onClick={() => window.api.shell.openUrl(job.url!)}>
            {jobLinkLabel}
          </Button>
        )}
      </div>
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
          actionsStatusColors={actionsStatusColors}
          summary={summaryParts.join(t('auto.components.editor.CheckRunJobs.5a8e1d4f23', ' · '))}
        />
      )}
    </div>
  )
}

export function CheckRunJobs({
  check,
  jobs,
  hasFailedJobs,
  positionOwner,
  jobLinkLabel,
  actionsStatusColors = false
}: {
  check?: PRCheckDetail
  jobs: PRCheckJob[]
  hasFailedJobs: boolean
  positionOwner?: CheckDetailsReadingOwner
  jobLinkLabel?: string
  actionsStatusColors?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const entries = checkJobIdentities(jobs)
  const visible = hasFailedJobs
    ? entries.filter(({ job }) => resolveStepOutcome(job) === 'failure')
    : entries
  const clipboardText = formatJobsForClipboard(
    visible.map(({ job }) => job),
    t('auto.components.editor.CheckRunDetailsPanel.ee07b33924', 'unknown')
  )

  return (
    <section className="min-w-0 rounded-md border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="text-sm font-medium">
          {hasFailedJobs
            ? t('auto.components.editor.CheckRunDetailsPanel.066fedd446', 'Failed jobs')
            : t('auto.components.editor.CheckRunDetailsPanel.49731703ea', 'Jobs')}
        </div>
        <CheckRunCopyButton
          text={clipboardText}
          label={t('auto.components.editor.CheckRunJobs.copy', 'Copy jobs')}
        />
      </div>
      <div className="divide-y divide-border/50">
        {visible.map(({ job, identity }) => (
          <JobCard
            key={identity}
            check={check}
            job={job}
            identity={identity}
            owner={positionOwner}
            jobLinkLabel={jobLinkLabel ?? t('checkRun.openJob', 'Open job')}
            actionsStatusColors={actionsStatusColors}
          />
        ))}
      </div>
    </section>
  )
}
