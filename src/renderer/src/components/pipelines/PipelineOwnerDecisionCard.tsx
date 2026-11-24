import type { PipelineSessionBinding } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import type { PipelineRunResource } from './pipeline-run-resource'
import { useSyncExternalStore } from 'react'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { SecuritySurface } from '@/components/ui/security-surface'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import type { usePipelineRun } from './use-pipeline-run'
import { PipelineTextField } from './PipelineFormFields'
import { PipelineArtifactView } from './PipelineArtifactView'
import {
  sendPipelineSessionDiscussion,
  pipelineDiscussionPending,
  subscribePipelineDiscussionSends
} from './pipeline-session-discussion-send'

async function discussPipelineOwnerResult(
  binding: PipelineSessionBinding | undefined,
  resource: PipelineRunResource,
  t: Translate
) {
  if (!binding) {
    return
  }
  const message = resource.snapshot().discussion
  try {
    const result = await sendPipelineSessionDiscussion({
      requestId: createBrowserUuid(),
      sessionId: binding.sessionId,
      message,
      hasAttachments: false
    })
    if (result.accepted && resource.snapshot().discussion === message) {
      resource.setText('discussion', '')
    }
    resource.setActionError(
      result.accepted
        ? undefined
        : (result.rejected ??
            t(
              'pipelines.discussionUnknown',
              'Message delivery is unconfirmed. Retry this same message to inspect its receipt.'
            ))
    )
  } catch (error) {
    resource.setActionError(String(error))
  } finally {
    await resource.refresh()
  }
}

export function PipelineOwnerDecisionCard({
  model,
  inline = false
}: {
  model: ReturnType<typeof usePipelineRun>
  inline?: boolean
}) {
  const t = useTranslate()
  const { read, resource } = model
  const binding = read?.status.run.currentInvocation?.session
  const pane = binding?.paneKey ? parsePaneKey(binding.paneKey) : null
  const ptyId = useAppStateValue((state) =>
    pane ? state.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId] : undefined
  )
  const sending = useSyncExternalStore(subscribePipelineDiscussionSends, () =>
    pipelineDiscussionPending(binding?.sessionId, ptyId)
  )
  if (!read) {
    return null
  }
  const run = read.status.run
  const pin = run.pendingDecision
  const stage = read.definition.stages.find((stage) => stage.id === run.stageId)!
  const active = run.currentInvocation && run.currentInvocation.state !== 'settled'
  const current =
    pin && read.status.sourceAvailable && pin.sourceRevision === read.status.sourceRevision
  const allowed = Boolean(
    pin &&
    current &&
    !active &&
    run.waitReason === 'owner_gate' &&
    !model.busy &&
    !model.pending &&
    !model.synchronization &&
    !model.error &&
    !sending
  )
  const textFits = JSON.stringify(model.comment).length <= 4000
  const discuss = () => discussPipelineOwnerResult(binding, resource, t)
  if (!pin && run.waitReason !== 'session_sync') {
    return null
  }
  return (
    <SecuritySurface>
      <section
        className="space-y-4 rounded-xl border border-status-warning-border bg-card p-4 text-card-foreground"
        aria-label={t('pipelines.ownerDecision', 'Pipeline decision')}
      >
        <p className="text-xs font-semibold text-status-warning-text">
          {t('pipelines.yourDecisionNeeded', 'Your decision is needed')}
        </p>
        <h3 className="text-base font-semibold">
          {stage.title} · {t('pipelines.waitsForYou', 'Waits for you')}
        </h3>
        {run.candidate && (
          <>
            <p className="whitespace-pre-wrap break-words text-sm">
              {run.candidate.summaryPreview}
            </p>
            <PipelineArtifactView
              scope={resource.scope}
              artifactId={run.candidate.id}
              label={
                run.candidate.summaryTruncated
                  ? t('pipelines.readFullResult', 'Read the full result')
                  : t('pipelines.resultEvidence', 'Result and evidence')
              }
            />
          </>
        )}
        {sending && (
          <p role="status" className="text-xs text-muted-foreground">
            {t(
              'pipelines.discussionUnknown',
              'Message delivery is unconfirmed. Retry this same message to inspect its receipt.'
            )}
          </p>
        )}
        {(!current ||
          ['session_sync', 'interrupted', 'blocked'].includes(run.waitReason ?? '') ||
          model.synchronization) && (
          <div className="space-y-2">
            <p className="text-sm">
              {stage.kind === 'checks'
                ? t(
                    'pipelines.recheckMeaning',
                    'The source changed. Rerun this check stage before making a decision. The previous result stays in its history.'
                  )
                : t(
                    'pipelines.synchronizeMeaning',
                    'The source or terminal input changed. Ask this same agent session to assess it before making a decision.'
                  )}
            </p>
            <Button
              variant="outline"
              disabled={
                Boolean(active) ||
                model.busy ||
                sending ||
                Boolean(model.pending) ||
                !run.definitionEnabled ||
                Boolean(model.error)
              }
              onClick={() =>
                void (stage.kind === 'checks'
                  ? resource.act({ kind: 'revalidate' }, read)
                  : resource.synchronize(read))
              }
            >
              {stage.kind === 'checks'
                ? t('pipelines.recheckStage', 'Rerun checks for current source')
                : t('pipelines.synchronize', 'Synchronize this session')}
            </Button>
          </div>
        )}
        {!inline && stage.kind === 'agent' && pin && (
          <div className="space-y-2">
            <PipelineTextField
              label={t('pipelines.discussionMessage', 'Discuss in the agent session')}
              value={model.discussion}
              multiline
              onChange={(value) => resource.setText('discussion', value)}
            />
            <Button
              variant="outline"
              disabled={
                !model.discussion.trim() ||
                JSON.stringify(model.discussion).length > 4000 ||
                model.busy ||
                Boolean(active) ||
                Boolean(model.pending) ||
                Boolean(model.synchronization) ||
                Boolean(model.error)
              }
              onClick={() => void discuss()}
            >
              {t('pipelines.sendDiscussion', 'Send to this session')}
            </Button>
          </div>
        )}
        {pin && (
          <>
            <p className="text-xs text-muted-foreground">
              {t(
                'pipelines.discussionNotAcceptance',
                'Chat messages discuss the result. Only these explicit decisions change the pipeline route.'
              )}
            </p>
            <PipelineTextField
              label={t('pipelines.ownerComment', 'Comment for the next stage or rework')}
              value={model.comment}
              multiline
              disabled={model.busy}
              onChange={(value) => resource.setText('comment', value)}
            />
            <p className="text-xs text-muted-foreground">
              {JSON.stringify(model.comment).length} / 4000
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!allowed || !textFits}
                onClick={() =>
                  void resource.act(
                    {
                      kind: 'decide',
                      action: 'accept',
                      ...(model.comment.trim() ? { comment: model.comment } : {})
                    },
                    read
                  )
                }
              >
                {pin.proposedTarget.kind === 'finish'
                  ? t('pipelines.acceptAndFinish', 'Accept and finish')
                  : t('pipelines.acceptAndContinue', 'Accept and continue')}
              </Button>
              <Button
                variant="outline"
                disabled={!allowed || !model.comment.trim() || !textFits}
                onClick={() =>
                  void resource.act(
                    { kind: 'decide', action: 'rework', comment: model.comment },
                    read
                  )
                }
              >
                {t('pipelines.reworkTo', 'Request changes → {{stage}}', {
                  stage:
                    read.definition.stages.find(
                      (value) => value.id === stage.ownerGate.reworkTargetStageId
                    )?.title ?? stage.ownerGate.reworkTargetStageId
                })}
              </Button>
            </div>
          </>
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
      </section>
    </SecuritySurface>
  )
}
