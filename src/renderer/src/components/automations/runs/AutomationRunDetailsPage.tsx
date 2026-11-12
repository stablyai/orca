import React, { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, ExternalLink, KeyRound, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/class-names'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { getAgentLabel } from '../authoring/automation-draft-model'
import { getAutomationRunContent } from './automation-run-content'
import { automationRunErrorText } from './automation-run-error-copy'
import type { AutomationRunViewState } from './automation-run-view-state'
import type { AutomationRunWorkspaceDisplay } from './automation-run-workspace-display'
import { useFullAutomationRun } from './use-full-automation-run'
import { pendingAutomationSetupReview } from '../authoring/automation-setup-review'
import type { SetupTrustMismatch } from '../../../../../shared/worktree/create-types'
import type { SelectedAutomationRunHistoryOutcome } from './use-selected-automation-run-history'
import {
  AUTOMATION_EDITOR_SECTION_LABEL_CLASS,
  AutomationRunErrorNotice,
  AutomationRunSetupSkippedNotice,
  formatAutomationDateTime,
  formatAutomationDateTimeWithRelative
} from '../automation-page-parts'
import { AutomationRunStatusLabel } from './AutomationRunStatusDot'
import { formatAutomationCost, formatAutomationTokens } from './automation-usage-model'
import {
  RUN_START_DRIFT_LABEL_MS,
  getAutomationRunLaunchedAt,
  formatAutomationRunLabel,
  getAutomationRunNeighbors,
  getAutomationRunStepKey
} from './automation-run-identity-label'
import { AutomationsPageFrame, AutomationsPageTitle } from '../AutomationsPageFrame'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'

function RunSection({
  title,
  children,
  className
}: {
  title: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section className={cn('min-w-0 rounded-lg border border-border/60', className)}>
      <h3
        className={cn(
          'border-b border-border/60 px-4 py-2.5 text-muted-foreground',
          AUTOMATION_EDITOR_SECTION_LABEL_CLASS
        )}
      >
        {title}
      </h3>
      <div className="px-4 py-3">{children}</div>
    </section>
  )
}

export function AutomationRunDetailsPage({
  nav,
  automation,
  run: listedRun,
  runs,
  history,
  relativeNow,
  hostLabel,
  workspaceDisplay,
  viewState,
  canRerun,
  isRerunPending,
  onRerun,
  onOpenWorkspace,
  onSignIn,
  onReviewSetup,
  onSelectRun
}: {
  nav: React.ReactNode
  automation: Automation | null
  run: AutomationRun
  /** The automation's history, newest first; Newer/Older step through it. */
  runs: readonly AutomationRun[]
  /** The read that listed `run`; Details re-reads its full row through the same owner. */
  history: SelectedAutomationRunHistoryOutcome
  relativeNow: number
  hostLabel: string
  workspaceDisplay: AutomationRunWorkspaceDisplay | null
  viewState: AutomationRunViewState | null
  canRerun: boolean
  isRerunPending: boolean
  onRerun: () => void
  onOpenWorkspace: () => void
  /** Reconnects the host that needed credentials; absent when nothing can sign in. */
  onSignIn?: () => void
  onReviewSetup: (content: SetupTrustMismatch) => void
  onSelectRun: (run: AutomationRun) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const full = useFullAutomationRun(listedRun, history)
  const run = full.run
  const failed = run.status === 'dispatch_failed'
  // Why: the detail's Last run shows when a run started; when that differs from its slot, say both.
  const startedAt = getAutomationRunLaunchedAt(run)
  const startedLate =
    startedAt !== null && Math.abs(startedAt - run.scheduledFor) >= RUN_START_DRIFT_LABEL_MS
  const agentLabel = automation ? getAgentLabel(automation.agentId) : undefined
  const errorText = automationRunErrorText(run, agentLabel)
  // Why: a failed run's reason has its own banner; Output shows only what the agent printed.
  const content = getAutomationRunContent(failed ? { ...run, error: null } : run, t)
  // Without the automation, the run can't be checked against its approval.
  const setupReview = automation
    ? pendingAutomationSetupReview(automation, {
        skipped: run.setupSkippedReason === 'setup-changed',
        content: run.setupSkippedContent
      })
    : { content: null }
  const reviewContent = setupReview?.content
  const { newer, older } = getAutomationRunNeighbors(runs, listedRun.id)
  const needsCredentials = run.status === 'skipped_needs_interactive_auth'

  const stepRef = useRef({ newer, older, onSelectRun })
  useEffect(() => {
    stepRef.current = { newer, older, onSelectRun }
  })
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const step = getAutomationRunStepKey(event)
      if (!step || hasVisibleOverlay()) {
        return
      }
      const target = stepRef.current[step]
      if (target) {
        event.preventDefault()
        stepRef.current.onSelectRun(target)
      }
    }
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [])

  const usageKnown = run.usage?.status === 'known'
  const details: { key: string; label: string; value: string; muted?: boolean }[] = [
    {
      key: 'workspace',
      label: t('auto.components.automations.AutomationRunHistory.149c0b49c7', 'Workspace'),
      value:
        workspaceDisplay?.rowLabel ??
        t('auto.components.automations.AutomationsPage.noWorkspace', 'No workspace'),
      muted: workspaceDisplay?.muted ?? true
    },
    {
      key: 'host',
      label: t('auto.components.automations.AutomationDetail.host', 'Host'),
      value: hostLabel
    },
    {
      key: 'spend',
      label: t('auto.components.automations.AutomationRunHistory.86a248187e', 'Spend'),
      value: formatAutomationCost(run.usage?.estimatedCostUsd, t),
      muted: !usageKnown
    },
    {
      key: 'tokens',
      label: t('auto.components.automations.AutomationRunHistory.13988187b3', 'Tokens'),
      value:
        usageKnown && run.usage
          ? formatAutomationTokens(run.usage.totalTokens, intlLocale)
          : t('auto.components.automations.AutomationRunHistory.a00e38d1a3', '—'),
      muted: !usageKnown
    },
    {
      key: 'trigger',
      label: t('auto.components.automations.AutomationRunsDashboard.trigger', 'Trigger'),
      value:
        run.trigger === 'manual'
          ? t('auto.components.automations.runIdentity.triggerManual', 'Run now')
          : t('auto.components.automations.runIdentity.triggerScheduled', 'Scheduled')
    }
  ]
  const stepLabel = {
    newer: t('auto.components.automations.runIdentity.newerRun', 'Newer run'),
    older: t('auto.components.automations.runIdentity.olderRun', 'Older run')
  }

  return (
    <AutomationsPageFrame nav={nav}>
      <div className="flex flex-col gap-4 pt-5">
        <header className="min-w-0">
          <div className="flex min-w-0 items-center gap-2.5">
            <AutomationsPageTitle>
              {formatAutomationRunLabel(run, t, intlLocale)}
            </AutomationsPageTitle>
            <AutomationRunStatusLabel status={run.status} pill />
            <span className="flex-1" />
            {(['newer', 'older'] as const).map((step) => {
              const target = step === 'newer' ? newer : older
              const Icon = step === 'newer' ? ChevronUp : ChevronDown
              return (
                <Tooltip key={step}>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={stepLabel[step]}
                        aria-keyshortcuts={step === 'newer' ? 'K' : 'J'}
                        disabled={!target}
                        onClick={() => target && onSelectRun(target)}
                      >
                        <Icon className="size-4" />
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}>
                    {stepLabel[step]}
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </div>
          <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            {startedLate ? (
              <>
                <span>
                  {t('auto.components.automations.runIdentity.scheduledAt', 'Scheduled {{time}}', {
                    time: formatAutomationDateTime(run.scheduledFor, t, intlLocale)
                  })}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {t('auto.components.automations.runIdentity.startedAt', 'Started {{time}}', {
                    time: formatAutomationDateTimeWithRelative(
                      startedAt,
                      relativeNow,
                      t,
                      intlLocale
                    )
                  })}
                </span>
              </>
            ) : (
              <span>
                {formatAutomationDateTimeWithRelative(run.scheduledFor, relativeNow, t, intlLocale)}
              </span>
            )}
            {automation ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{getAgentLabel(automation.agentId)}</span>
              </>
            ) : null}
            {run.outputSnapshot?.truncated ? (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {t(
                    'auto.components.automations.AutomationsPage.latestSavedOutput',
                    'Latest saved output'
                  )}
                </span>
              </>
            ) : null}
          </p>
        </header>

        {run.setupSkippedReason === 'setup-changed' ? (
          <AutomationRunSetupSkippedNotice
            review={setupReview}
            onReview={reviewContent ? () => onReviewSetup(reviewContent) : undefined}
          />
        ) : null}
        {needsCredentials ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <span className="min-w-0 flex-1">
              {errorText ??
                t(
                  'auto.components.automations.runIdentity.needsCredentials',
                  '{{host}} needs credentials to reconnect, so this run did not start.',
                  { host: hostLabel }
                )}
            </span>
            {onSignIn ? (
              <Button type="button" variant="outline" size="xs" onClick={onSignIn}>
                <KeyRound className="size-3.5" />
                {t('auto.components.automations.runIdentity.signIn', 'Sign in to {{host}}', {
                  host: hostLabel
                })}
              </Button>
            ) : null}
          </div>
        ) : failed ? (
          <AutomationRunErrorNotice
            label={t('auto.components.automations.runIdentity.runFailed', 'Run failed.')}
            error={
              errorText ??
              t(
                'auto.components.automations.runIdentity.noFailureReason',
                'This run did not start, and no reason was recorded.'
              )
            }
          />
        ) : null}

        {viewState?.canOpen || (canRerun && automation) ? (
          <div className="flex flex-wrap items-center gap-2">
            {/* Why: a disabled button with nothing to open reads as broken; Details says the workspace is gone. */}
            {viewState?.canOpen ? (
              <Button type="button" size="sm" onClick={onOpenWorkspace}>
                <ExternalLink className="size-3.5" />
                {t('auto.components.automations.runViewState.openWorkspace', 'Open workspace')}
              </Button>
            ) : null}
            {canRerun && automation ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isRerunPending}
                onClick={onRerun}
              >
                <RefreshCw className={cn('size-3.5', isRerunPending && 'animate-spin')} />
                {t('auto.components.automations.AutomationsPage.295698292f', 'Rerun')}
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="@container">
          <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-[minmax(0,1fr)_16rem]">
            <RunSection title={t('auto.components.automations.runIdentity.output', 'Output')}>
              {full.failed ? (
                <div
                  role="alert"
                  className="mb-3 flex items-center gap-2 text-sm text-muted-foreground"
                >
                  {t(
                    'auto.components.automations.AutomationsPage.fullOutputUnavailable',
                    "Couldn't load the full output."
                  )}
                  <Button type="button" variant="outline" size="xs" onClick={full.retry}>
                    {t('auto.components.automations.AutomationsPage.retryFullOutput', 'Retry')}
                  </Button>
                </div>
              ) : null}
              <CommentMarkdown
                variant="document"
                content={content}
                className="text-sm leading-relaxed text-foreground"
              />
            </RunSection>
            <RunSection
              className="self-start"
              title={t('auto.components.automations.runIdentity.details', 'Details')}
            >
              <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13px]">
                {details.map((detail) => (
                  <React.Fragment key={detail.key}>
                    <dt className="text-muted-foreground">{detail.label}</dt>
                    <dd
                      className={cn(
                        'min-w-0 truncate',
                        detail.muted ? 'text-muted-foreground' : 'text-foreground'
                      )}
                      title={detail.value}
                    >
                      {detail.value}
                    </dd>
                  </React.Fragment>
                ))}
              </dl>
            </RunSection>
          </div>
        </div>
      </div>
    </AutomationsPageFrame>
  )
}
