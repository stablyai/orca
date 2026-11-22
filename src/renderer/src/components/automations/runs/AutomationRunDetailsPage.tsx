import React, { useEffect, useRef } from 'react'
import { ArrowUpRight, ChevronLeft, ChevronRight, KeyRound, Monitor, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import CommentMarkdown from '@/components/comment-markdown/CommentMarkdown'
import { cn } from '@/lib/class-names'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { automationRunEventSourceKey } from '../../../../../shared/automations/automation-run-row-words'
import { sayAutomationRun } from '../../native-chat/automation-run/automation-run-wording'
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
  const savedError = automationRunErrorText(run, agentLabel)
  const errorText =
    run.status === 'dispatch_failed' &&
    run.sessionKind === 'chat' &&
    savedError === "The bot's turn ended without finishing (failure)."
      ? t(
          'automations.runFailures.botProviderErrorNotSaved',
          "The bot's turn failed, but this run did not save the provider's error. The original Chat may contain more details."
        )
      : savedError
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

  const usage = run.usage?.status === 'known' ? run.usage : null
  const cost = usage?.estimatedCostUsd
  const tokens = usage?.totalTokens
  const hasCost = cost != null
  const hasTokens = tokens != null
  const workspaceName = listedRun.workspaceId
    ? (workspaceDisplay?.title ?? workspaceDisplay?.detailLabel)
    : null
  const triggerLabel =
    run.trigger === 'manual'
      ? t('auto.components.automations.runIdentity.triggerManual', 'Run now')
      : run.trigger === 'event'
        ? sayAutomationRun(t)(automationRunEventSourceKey(run))
        : t('auto.components.automations.runIdentity.triggerScheduled', 'Scheduled')
  // Nonbreaking spaces keep the dot on the same line as the preceding text.
  const dot = (
    <span aria-hidden="true" className="text-muted-foreground">
      {'\u00a0\u00a0·'}
    </span>
  )
  const rerunLabel = t('auto.components.automations.AutomationsPage.295698292f', 'Rerun')
  const stepLabel = {
    newer: t('auto.components.automations.runIdentity.newerRun', 'Newer run'),
    older: t('auto.components.automations.runIdentity.olderRun', 'Older run')
  }

  return (
    <AutomationsPageFrame nav={nav}>
      <div className="flex flex-col gap-4 pt-5">
        <header className="@container/run-header min-w-0">
          <div className="flex min-w-0 items-center gap-2.5">
            <AutomationsPageTitle>
              {formatAutomationRunLabel(run, t, intlLocale)}
            </AutomationsPageTitle>
            <AutomationRunStatusLabel status={run.status} pill />
            <span className="flex-1" />
            {canRerun && automation ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="@max-[32.5rem]/run-header:hidden"
                  disabled={isRerunPending}
                  onClick={onRerun}
                >
                  <RefreshCw
                    className={cn('size-3.5', isRerunPending && 'motion-safe:animate-spin')}
                  />
                  {rerunLabel}
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="shrink-0 @min-[32.5rem]/run-header:hidden">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-label={rerunLabel}
                        disabled={isRerunPending}
                        onClick={onRerun}
                      >
                        <RefreshCw
                          className={cn('size-3.5', isRerunPending && 'motion-safe:animate-spin')}
                        />
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}>
                    {rerunLabel}
                  </TooltipContent>
                </Tooltip>
              </>
            ) : null}
            {/* Why: left reads as back in time, so Older sits left and Newer right. */}
            {(['older', 'newer'] as const).map((step) => {
              const target = step === 'newer' ? newer : older
              const Icon = step === 'newer' ? ChevronRight : ChevronLeft
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
          <p className="mt-1 flex min-w-0 flex-wrap gap-x-2 text-sm wrap-anywhere text-muted-foreground">
            {startedLate ? (
              <>
                <span>
                  {t('auto.components.automations.runIdentity.scheduledAt', 'Scheduled {{time}}', {
                    time: formatAutomationDateTime(run.scheduledFor, t, intlLocale)
                  })}
                  {dot}
                </span>
                <span>
                  {t('auto.components.automations.runIdentity.startedAt', 'Started {{time}}', {
                    time: formatAutomationDateTimeWithRelative(
                      startedAt,
                      relativeNow,
                      t,
                      intlLocale
                    )
                  })}
                  {dot}
                </span>
              </>
            ) : (
              <span>
                {formatAutomationDateTimeWithRelative(run.scheduledFor, relativeNow, t, intlLocale)}
                {dot}
              </span>
            )}
            {agentLabel ? (
              <span>
                {agentLabel}
                {dot}
              </span>
            ) : null}
            {run.outputSnapshot?.truncated ? (
              <span>
                {t(
                  'auto.components.automations.AutomationsPage.latestSavedOutput',
                  'Latest saved output'
                )}
                {dot}
              </span>
            ) : null}
            <span>
              {triggerLabel}
              {dot}
            </span>
            {workspaceName ? (
              <span className="min-w-0">
                {viewState?.canOpen ? (
                  <button
                    type="button"
                    className="group max-w-full cursor-pointer rounded-sm text-left text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    onClick={onOpenWorkspace}
                  >
                    <span className="group-hover:underline">{workspaceName}</span>
                    <span className="whitespace-nowrap">
                      <ArrowUpRight
                        aria-hidden="true"
                        className="ml-0.5 inline size-3 align-[-0.125em] text-muted-foreground"
                      />
                      {dot}
                    </span>
                  </button>
                ) : (
                  <>
                    {workspaceName}
                    {dot}
                  </>
                )}
              </span>
            ) : null}
            <span>
              <Monitor aria-hidden="true" className="mr-1 inline size-3.5 align-[-0.15em]" />
              {hostLabel}
              {hasCost || hasTokens ? dot : null}
            </span>
            {hasCost ? (
              <span>
                {t('auto.components.automations.usage.spent', '{{spend}} spent', {
                  spend: formatAutomationCost(cost, t)
                })}
                {hasTokens ? dot : null}
              </span>
            ) : null}
            {hasTokens ? (
              <span>
                {t('auto.components.automations.usage.tokens', '{{tokens}} tokens', {
                  count: tokens,
                  tokens: formatAutomationTokens(tokens, intlLocale),
                  defaultValue_one: '{{tokens}} token'
                })}
              </span>
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

        <section className="min-w-0 rounded-lg border border-border/60">
          <h3
            className={cn(
              'border-b border-border/60 px-4 py-2.5 text-muted-foreground',
              AUTOMATION_EDITOR_SECTION_LABEL_CLASS
            )}
          >
            {t('auto.components.automations.runIdentity.output', 'Output')}
          </h3>
          <div className="px-4 py-3">
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
              singleTildeStrikethrough={false}
              className="text-sm leading-relaxed text-foreground"
            />
          </div>
        </section>
      </div>
    </AutomationsPageFrame>
  )
}
