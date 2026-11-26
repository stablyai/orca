import { openPipelineSession } from './pipeline-session-navigation'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { usePipelineRun } from './use-pipeline-run'
import type { PipelineWorkspace } from './use-pipeline-workspace'
import { pipelineRunStateLabel } from './pipeline-run-labels'
import { PipelineArtifactView } from './PipelineArtifactView'
import { PipelineStatusBadge } from './PipelineStatusBadge'
import { cn } from '@/lib/class-names'

export function PipelineTimeline({
  model,
  workspace
}: {
  model: ReturnType<typeof usePipelineRun>
  workspace: PipelineWorkspace
}) {
  const t = useTranslate()
  const { read, resource } = model
  if (!read) {
    return null
  }
  return (
    <ol className="space-y-3" aria-label={t('pipelines.timeline', 'Pipeline visits')}>
      {read.visits.map((visit, index) => {
        const stage = read.definition.stages.find((stage) => stage.id === visit.stageId)
        const target = visit.decision?.target
        return (
          <li
            key={visit.id}
            id={`pipeline-attempt-${encodeURIComponent(visit.id)}`}
            className={cn(
              'relative scroll-mt-4 space-y-4 rounded-xl border bg-card p-4 text-card-foreground',
              visit.state === 'waiting_owner' && 'border-l-4 border-l-status-warning',
              visit.state === 'running' && 'border-l-4 border-l-ring'
            )}
            aria-current={visit.id === read.status.run.currentVisitId ? 'step' : undefined}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <h3 className="break-words text-sm font-semibold">
                    {stage?.title ?? visit.stageId}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {t('pipelines.stageAttempt', 'Attempt {{attempt}}', {
                      attempt: visit.attempt + 1
                    })}
                  </p>
                </div>
              </div>
              <PipelineStatusBadge
                state={visit.decision?.action === 'rework' ? 'rework' : visit.state}
                label={
                  visit.decision?.action === 'rework'
                    ? t('pipelines.changesRequested', 'Changes requested')
                    : pipelineRunStateLabel(visit.state, t)
                }
              />
            </div>
            <p className="break-words text-xs text-muted-foreground">
              {stage?.kind === 'agent' && stage.evidenceSchema === 'review' && (
                <span>
                  {stage.independent
                    ? t('pipelines.independentReviewLabel', 'Independent review')
                    : t('pipelines.selfReviewLabel', 'Review · independence not required')}
                  {' · '}
                </span>
              )}
              {visit.executor
                ? [
                    visit.executor.agent,
                    visit.executor.model,
                    visit.executor.effort,
                    visit.executor.surface
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : t('pipelines.nativeChecks', 'Native checks')}
              {visit.discussionTurns > 0
                ? ` · ${t('pipelines.discussionCount', '{{count}} discussion turns', { count: visit.discussionTurns })}`
                : ''}
            </p>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                {t('pipelines.stageUsage', 'Time: {{time}} · tokens: {{tokens}} · USD: unknown', {
                  time:
                    visit.usage?.durationMs != null
                      ? `${(visit.usage.durationMs / 1000).toFixed(1)} s`
                      : 'unknown',
                  tokens: visit.usage?.tokens
                    ? `${visit.usage.tokens.uncachedInput} input + ${visit.usage.tokens.cacheReadInput} cache read + ${visit.usage.tokens.cacheWriteInput} cache write + ${visit.usage.tokens.output} output`
                    : 'unknown'
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(
                  'pipelines.reportedTurnUsageMeaning',
                  'Provider-reported root-turn tokens; helper usage may be unreported. Input excludes cache; reasoning is a subset of output. Context-window estimates are not usage totals.'
                )}
              </p>
              <h4 className="text-xs font-semibold">{t('pipelines.stageResult', 'Result')}</h4>
              {visit.resultPreview?.checkResult && (
                <PipelineStatusBadge
                  state={
                    visit.resultPreview.checkResult === 'passed'
                      ? 'completed'
                      : visit.resultPreview.checkResult === 'failed'
                        ? 'failed'
                        : 'reconciliation_required'
                  }
                  label={
                    visit.resultPreview.checkResult === 'passed'
                      ? t('pipelines.checksResultPassed', 'Checks passed')
                      : visit.resultPreview.checkResult === 'failed'
                        ? t('pipelines.checksResultFailed', 'Checks failed')
                        : t('pipelines.checkUnknown', 'Result unknown')
                  }
                />
              )}
              {visit.resultPreview?.reviewFindings !== undefined && (
                <PipelineStatusBadge
                  state={visit.resultPreview.reviewFindings === 0 ? 'completed' : 'blocked'}
                  label={
                    visit.resultPreview.reviewFindings === 0
                      ? t('pipelines.reviewClear', 'No review findings')
                      : t('pipelines.reviewFindingCount', 'Review findings: {{count}}', {
                          count: visit.resultPreview.reviewFindings
                        })
                  }
                />
              )}
              <p className="whitespace-pre-wrap break-words text-sm">
                {visit.resultPreview
                  ? `${visit.resultPreview.summary}${visit.resultPreview.truncated ? '…' : ''}`
                  : visit.latestCandidateId
                    ? t('pipelines.openResultBelow', 'Open the full result below.')
                    : visit.state === 'running'
                      ? t(
                          'pipelines.resultPending',
                          'The stage is running. No result has been submitted yet.'
                        )
                      : t(
                          'pipelines.noStageResult',
                          'No result has been submitted for this attempt.'
                        )}
              </p>
            </div>
            {visit.decision && (
              <div className="space-y-2 border-t pt-3">
                <h4 className="text-xs font-semibold">
                  {t('pipelines.decisionAndNext', 'Decision and next step')}
                </h4>
                <p className="text-sm">
                  {visit.decision.action === 'accept'
                    ? t('pipelines.ownerAccepted', 'Owner accepted the result')
                    : t('pipelines.ownerRequestedChanges', 'Owner requested changes')}
                  {visit.decision.outcomeId
                    ? ` · ${stage?.outcomes.find((outcome) => outcome.id === visit.decision?.outcomeId)?.title ?? visit.decision.outcomeId}`
                    : ''}{' '}
                  →{' '}
                  {target?.kind === 'finish'
                    ? t('pipelines.finish', 'Finish workflow')
                    : target?.kind === 'stage'
                      ? (read.definition.stages.find((stage) => stage.id === target.stageId)
                          ?.title ?? target.stageId)
                      : ''}
                </p>
                {visit.decision.commentPreview && (
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {visit.decision.commentPreview}
                    {visit.decision.commentTruncated ? '…' : ''}
                  </p>
                )}
                <PipelineArtifactView
                  scope={resource.scope}
                  artifactId={visit.decision.artifactId}
                  label={t('pipelines.ownerDecisionDetails', 'Full owner decision')}
                />
              </div>
            )}
            {!visit.decision && visit.outcome && (
              <p className="border-t pt-3 text-sm">
                {stage?.outcomes.find((outcome) => outcome.id === visit.outcome?.id)?.title ??
                  visit.outcome.id}{' '}
                →{' '}
                {visit.outcome.target.kind === 'finish'
                  ? t('pipelines.finish', 'Finish workflow')
                  : (read.definition.stages.find(
                      (stage) =>
                        visit.outcome?.target.kind === 'stage' &&
                        stage.id === visit.outcome.target.stageId
                    )?.title ?? '')}
              </p>
            )}
            {visit.blockReason && (
              <p className="whitespace-pre-wrap break-words text-sm">{visit.blockReason}</p>
            )}
            <div className="space-y-2 border-t pt-3">
              {visit.latestCandidateId && (
                <PipelineArtifactView
                  scope={resource.scope}
                  artifactId={visit.acceptedCandidateId ?? visit.latestCandidateId}
                  label={t('pipelines.fullStageResult', 'Full result and files')}
                />
              )}
              {visit.session && visit.session.kind !== 'checks' && (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => {
                    void openPipelineSession(workspace, visit.session!, read.runtimeId).catch(
                      (error) => resource.setActionError(String(error))
                    )
                  }}
                >
                  {t('pipelines.openSession', 'Open this session')}
                </Button>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
