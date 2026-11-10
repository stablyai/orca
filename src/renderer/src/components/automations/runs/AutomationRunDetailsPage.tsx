import React from 'react'
import { Eye, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/class-names'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { AutomationRunPageFrame } from './AutomationRunPageFrame'
import { getAutomationRunContent } from './automation-run-content'
import { automationRunErrorText } from './automation-run-error-copy'
import type { AutomationRunViewState } from './automation-run-view-state'
import type { AutomationRunWorkspaceDisplay } from './automation-run-workspace-display'
import { useFullAutomationRun } from './use-full-automation-run'
import { pendingAutomationSetupReview } from '../authoring/automation-setup-review'
import type { SetupTrustMismatch } from '../../../../../shared/worktree/create-types'
import type { SelectedAutomationRunHistoryOutcome } from './use-selected-automation-run-history'
import {
  AutomationRunErrorNotice,
  AutomationRunSetupSkippedNotice,
  formatAutomationDateTimeWithRelative,
  getAutomationRunStatusLabel,
  getAutomationRunStatusVariant
} from '../automation-page-parts'

export function AutomationRunDetailsPage({
  automation,
  run: listedRun,
  history,
  relativeNow,
  workspaceDisplay,
  viewState,
  canRerun,
  isRerunPending,
  onRerun,
  onOpenWorkspace,
  onReviewSetup,
  onBack
}: {
  automation: Automation | null
  run: AutomationRun
  /** The read that listed `run`; Details re-reads its full row through the same owner. */
  history: SelectedAutomationRunHistoryOutcome
  relativeNow: number
  workspaceDisplay: AutomationRunWorkspaceDisplay | null
  viewState: AutomationRunViewState | null
  canRerun: boolean
  isRerunPending: boolean
  onRerun: () => void
  onOpenWorkspace: () => void
  onReviewSetup: (content: SetupTrustMismatch) => void
  onBack: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const full = useFullAutomationRun(listedRun, history)
  const run = full.run
  const content = getAutomationRunContent(run, t)
  const errorText = automationRunErrorText(run)
  // Without the automation, the run can't be checked against its approval.
  const setupReview = automation
    ? pendingAutomationSetupReview(automation, {
        skipped: run.setupSkippedReason === 'setup-changed',
        content: run.setupSkippedContent
      })
    : { content: null }
  const reviewContent = setupReview?.content
  return (
    <section className="flex min-h-0 flex-1 p-5">
      <AutomationRunPageFrame
        title={automation?.name ?? run.title}
        breadcrumbs={[
          formatAutomationDateTimeWithRelative(run.scheduledFor, relativeNow, t, intlLocale),
          'Orca',
          workspaceDisplay?.detailLabel ??
            t('auto.components.automations.AutomationsPage.noWorkspace', 'No workspace')
        ]}
        detail={
          run.outputSnapshot?.truncated
            ? t(
                'auto.components.automations.AutomationsPage.latestSavedOutput',
                'Latest saved output'
              )
            : null
        }
        statusLabel={getAutomationRunStatusLabel(run.status, t)}
        statusVariant={getAutomationRunStatusVariant(run.status)}
        actions={
          <>
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
            {/* Why: a disabled button with nothing to open reads as broken; status and content explain the run. */}
            {viewState?.canOpen ? (
              <Button type="button" variant="outline" size="sm" onClick={onOpenWorkspace}>
                <Eye className="size-3.5" />
                {viewState.actionLabel}
              </Button>
            ) : null}
          </>
        }
        onBack={onBack}
      >
        {run.setupSkippedReason === 'setup-changed' ? (
          <AutomationRunSetupSkippedNotice
            className="mb-4"
            review={setupReview}
            onReview={reviewContent ? () => onReviewSetup(reviewContent) : undefined}
          />
        ) : null}
        {/* Why: saved terminal output otherwise hides why the run failed. */}
        {run.status === 'dispatch_failed' && errorText && content !== errorText ? (
          <AutomationRunErrorNotice
            className="mb-4"
            label={t('auto.components.automations.AutomationsPage.runError', 'Error:')}
            error={errorText}
          />
        ) : null}
        {full.failed ? (
          <div role="alert" className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
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
      </AutomationRunPageFrame>
    </section>
  )
}
