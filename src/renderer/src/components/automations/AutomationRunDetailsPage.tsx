import React from 'react'
import { Eye, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import { AutomationRunPageFrame } from './AutomationRunPageFrame'
import {
  AutomationRunResults,
  AutomationRunSectionLabel,
  type AutomationRunOutputActions
} from './AutomationRunResults'
import { getAutomationRunContent } from './automation-run-content'
import { automationRunErrorText } from './automation-run-error-copy'
import type { AutomationRunViewState } from './automation-run-view-state'
import type { AutomationRunWorkspaceDisplay } from './automation-run-workspace-display'
import {
  AutomationRunErrorNotice,
  formatAutomationDateTimeWithRelative,
  AutomationRunStatusBadge
} from './automation-page-parts'

export function AutomationRunDetailsPage({
  automation,
  run,
  relativeNow,
  workspaceDisplay,
  viewState,
  canRerun,
  isRerunPending,
  onRerun,
  onOpenWorkspace,
  onBack,
  outputActions
}: {
  automation: Automation | null
  run: AutomationRun
  relativeNow: number
  workspaceDisplay: AutomationRunWorkspaceDisplay | null
  viewState: AutomationRunViewState | null
  canRerun: boolean
  isRerunPending: boolean
  onRerun: () => void
  onOpenWorkspace: () => void
  onBack: () => void
  outputActions: AutomationRunOutputActions
}): React.JSX.Element {
  const content = getAutomationRunContent(run)
  const errorText = run.reportedFailure?.message ?? automationRunErrorText(run)
  return (
    <section className="flex min-h-0 flex-1">
      <AutomationRunPageFrame
        title={automation?.name ?? run.title}
        breadcrumbs={[
          formatAutomationDateTimeWithRelative(run.scheduledFor, relativeNow),
          'Orca',
          workspaceDisplay?.detailLabel ??
            translate('auto.components.automations.AutomationsPage.noWorkspace', 'No workspace')
        ]}
        detail={
          run.outputSnapshot?.truncated
            ? translate(
                'auto.components.automations.AutomationsPage.latestSavedOutput',
                'Latest saved output'
              )
            : null
        }
        status={<AutomationRunStatusBadge run={run} />}
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
                {translate('auto.components.automations.AutomationsPage.295698292f', 'Rerun')}
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
        {/* Why: saved terminal output otherwise hides why the run failed. */}
        {errorText && (run.reportedFailure || content !== errorText) ? (
          <AutomationRunErrorNotice error={errorText} />
        ) : null}
        {/* The agent's answer leads; warnings and attachments qualify it. */}
        <section>
          {run.outputSnapshot ? (
            <AutomationRunSectionLabel>
              {translate('auto.components.automations.AutomationRunDetailsPage.summary', 'Summary')}
            </AutomationRunSectionLabel>
          ) : null}
          <CommentMarkdown
            variant="document"
            content={content}
            className="max-w-[68ch] text-sm leading-relaxed text-foreground"
          />
        </section>
        <AutomationRunResults run={run} actions={outputActions} />
      </AutomationRunPageFrame>
    </section>
  )
}
