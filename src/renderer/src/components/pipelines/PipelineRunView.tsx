import { openPipelineSession } from './pipeline-session-navigation'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { usePipelineRun } from './use-pipeline-run'
import type { PipelineWorkspace } from './use-pipeline-workspace'
import { PipelineOwnerDecisionCard } from './PipelineOwnerDecisionCard'
import { PipelineTimeline } from './PipelineTimeline'
import { PipelineBudgetEditor } from './PipelineBudgetEditor'
import { PipelineOwnerRequests } from './PipelineOwnerRequests'
import { PipelineRetainedInputs } from './PipelineRetainedInputs'
import { PipelineStatusBadge } from './PipelineStatusBadge'
import { PipelineTemplatePreview } from './PipelineTemplatePreview'
import { PipelineRunRoute } from './PipelineRunRoute'
import { PipelineTerminology } from './PipelineTerminology'
import { PipelineFindings } from './PipelineFindings'
import { pipelineRunReasonLabel } from './pipeline-run-labels'

export function PipelineRunView({ workspace }: { workspace: PipelineWorkspace }) {
  const t = useTranslate()
  const model = usePipelineRun({
    projectId: workspace.pipeline.projectId,
    workspaceInstanceId: workspace.instanceId,
    runId: workspace.pipeline.runId
  })
  const { read, resource } = model
  if (!read) {
    return (
      <div className="space-y-3 p-4">
        <p className="text-sm">
          {resource.capacity
            ? t(
                'pipelines.retentionCapacity',
                'Retained input has reached its limit. Open Retained input to copy and release a closed run before continuing.'
              )
            : model.error || t('pipelines.loadingRun', 'Loading the pipeline…')}
        </p>
        <PipelineRetainedInputs />
        {model.error && !resource.capacity && (
          <Button variant="outline" onClick={() => void resource.refresh()}>
            {t('pipelines.retryRead', 'Retry connection')}
          </Button>
        )}
      </div>
    )
  }
  const run = read.status.run
  const current = read.definition.stages.find((stage) => stage.id === run.stageId)
  const session = run.currentInvocation?.session
  return (
    <div className="space-y-6 p-5">
      <section className="space-y-4 rounded-xl border bg-card p-5 text-card-foreground">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs text-muted-foreground">
              {t('pipelines.runStatus', 'Run status')}
            </p>
            <h2 className="text-lg font-semibold">
              {run.state === 'completed'
                ? t('pipelines.workflowFinished', 'Workflow completed')
                : current?.title}
            </h2>
          </div>
          <PipelineStatusBadge state={run.state} />
        </div>
        <p className="text-sm text-muted-foreground">
          {t('pipelines.usingTemplate', 'Template: {{title}} · version {{version}}', {
            title: read.definition.title,
            version: read.definition.version
          })}
        </p>
        {run.currentExecutor && (
          <p className="break-words text-xs text-muted-foreground">
            {[
              run.currentExecutor.agent,
              run.currentExecutor.model,
              run.currentExecutor.effort,
              run.currentExecutor.surface
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
        <p className="text-sm">
          {read.status.ready && read.status.currentEvidence
            ? t(
                'pipelines.sourceReadyByPolicy',
                'Current source passed its selected checks and review requirements.'
              )
            : read.status.workflowComplete
              ? read.definition.completionPolicy.kind === 'workflow_complete'
                ? t(
                    'pipelines.workflowMeaning',
                    'This policy confirms the workflow finished. It does not certify code readiness.'
                  )
                : t(
                    'pipelines.sourceStale',
                    'The workflow finished, but current source readiness is not confirmed.'
                  )
              : t('pipelines.inProgress', 'The configured workflow is still in progress.')}
        </p>
        {!run.definitionEnabled && (
          <p className="text-sm">
            {t(
              'pipelines.versionDisabled',
              'This template version is disabled. New stage dispatches are held.'
            )}
          </p>
        )}
        {(run.reason || read.status.reason) && (
          <p className="break-words text-sm">
            {pipelineRunReasonLabel(run.reason ?? read.status.reason, t)}
          </p>
        )}
        {run.currentInvocation?.responseObservation && (
          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              {t('pipelines.responseDetails', 'Response and validation details')}
            </summary>
            <pre className="scrollbar-sleek mt-3 overflow-auto whitespace-pre-wrap break-words text-xs">
              {JSON.stringify(run.currentInvocation.responseObservation, null, 2)}
            </pre>
          </details>
        )}
        {run.state === 'reconciliation_required' && (
          <p className="text-sm text-muted-foreground">
            {t(
              'pipelines.reconcileMeaning',
              'Inspect completion of the existing invocation. This never starts another agent; without proof, the run stays on hold.'
            )}
          </p>
        )}
        {['blocked', 'interrupted'].includes(run.waitReason ?? '') && (
          <p className="text-sm text-muted-foreground">
            {t(
              'pipelines.retryMeaning',
              'Retry creates a new visit to this stage and uses its return budget. Previous results stay in history; a paused run stays paused.'
            )}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {['running', 'waiting_setup', 'waiting_owner'].includes(run.state) && (
            <Button
              variant="outline"
              disabled={model.busy || Boolean(model.pending)}
              onClick={() => void resource.act({ kind: 'pause' }, read)}
            >
              {t('pipelines.pause', 'Pause')}
            </Button>
          )}
          {run.state === 'paused' && (
            <Button
              variant="outline"
              disabled={model.busy || Boolean(model.pending) || !run.definitionEnabled}
              onClick={() => void resource.act({ kind: 'resume' }, read)}
            >
              {t('pipelines.resume', 'Resume')}
            </Button>
          )}
          {run.state === 'reconciliation_required' && (
            <Button
              variant="outline"
              disabled={model.busy || Boolean(model.pending)}
              onClick={() => void resource.act({ kind: 'reconcile' }, read)}
            >
              {t('pipelines.reconcileExisting', 'Inspect the existing invocation')}
            </Button>
          )}
          {['paused', 'waiting_owner'].includes(run.state) &&
            ['blocked', 'interrupted'].includes(run.waitReason ?? '') && (
              <Button
                variant="outline"
                disabled={model.busy || Boolean(model.pending) || !run.definitionEnabled}
                onClick={() => void resource.act({ kind: 'retry' }, read)}
              >
                {t('pipelines.retryStage', 'Retry this stage')}
              </Button>
            )}
          {((run.state === 'completed' &&
            read.definition.completionPolicy.kind === 'reviewed_source') ||
            run.pendingTransition?.target.kind === 'finish') && (
            <Button
              variant="outline"
              disabled={model.busy || Boolean(model.pending)}
              onClick={() => void resource.act({ kind: 'revalidate' }, read)}
            >
              {t('pipelines.revalidate', 'Revalidate current source')}
            </Button>
          )}
          <PipelineBudgetEditor model={model} />
          {session && session.kind !== 'checks' && (
            <Button
              variant="outline"
              onClick={() => {
                void openPipelineSession(workspace, session, read.runtimeId).catch((error) =>
                  resource.setActionError(String(error))
                )
              }}
            >
              {t('pipelines.openSession', 'Open this session')}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('pipelines.usedTurns', 'Agent turns {{used}} / {{limit}}', {
            used: run.usedInvocations,
            limit: run.effectiveLimits.maxInvocations
          })}{' '}
          ·{' '}
          {t('pipelines.usedDiscussions', 'Discussion {{used}} / {{limit}}', {
            used: run.effectiveLimits.usedDiscussionTurns,
            limit: run.effectiveLimits.maxDiscussionTurns
          })}{' '}
          ·{' '}
          {t('pipelines.usedReturns', 'Returns {{used}} / {{limit}}', {
            used: run.effectiveLimits.usedReentries,
            limit: run.effectiveLimits.maxReentries
          })}
        </p>
      </section>
      <PipelineOwnerDecisionCard model={model} />
      <PipelineFindings model={model} />
      <PipelineRunRoute read={read} />
      <PipelineTerminology />
      {model.error && (
        <p role="alert" className="text-sm text-destructive">
          {model.error}
        </p>
      )}
      {model.actionError && (
        <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">
          {model.actionError}
        </p>
      )}
      {model.pending && (
        <Button variant="outline" disabled={model.busy} onClick={() => void resource.reconcile()}>
          {t('pipelines.checkActionResult', 'Check action result')}
        </Button>
      )}
      {model.receipt && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('pipelines.actionConfirmed', 'Action confirmed at revision {{revision}}.', {
            revision: model.receipt.acceptedRevision
          })}
        </p>
      )}
      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold">
            {t('pipelines.actualHistory', 'Execution history')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              'pipelines.actualHistoryMeaning',
              'Actual attempts in order, including returns for changes.'
            )}
          </p>
        </div>
        <PipelineTimeline model={model} workspace={workspace} />
      </section>
      <details className="rounded-md border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          {t('pipelines.possibleRoute', 'Template · possible stages and transitions')}
        </summary>
        <div className="mt-4">
          <PipelineTemplatePreview template={read.definition} />
        </div>
      </details>
      <details className="rounded-md border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          {t('pipelines.decisionsAndHistory', 'Requests for your decision')}
        </summary>
        <div className="mt-4">
          <PipelineOwnerRequests
            projectId={run.workspace.projectId}
            runId={run.id}
            onResolved={() => {
              void resource.refresh()
            }}
          />
        </div>
      </details>
      <details className="rounded-md border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          {t('pipelines.recoveryAndDetails', 'Recovery and technical details')}
        </summary>
        <div className="mt-4 space-y-3">
          <PipelineRetainedInputs />
          <p className="text-xs text-muted-foreground">
            {t('pipelines.usageUnknown', 'Token usage and cost have not been reported.')}
          </p>
          <p className="break-all font-mono text-xs text-muted-foreground">{run.id}</p>
        </div>
      </details>
    </div>
  )
}
