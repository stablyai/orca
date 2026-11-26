import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type {
  PipelineOwnerProposalRead,
  PipelineOwnerProposalDetails
} from './pipeline-owner-proposals'
import { PipelineStatusBadge } from './PipelineStatusBadge'
import { PipelineOwnerRequestIntent } from './PipelineOwnerRequestIntent'
import { PipelineTemplatePreview } from './PipelineTemplatePreview'
import { PipelineLaunchPreview } from './PipelineLaunchPreview'
import { pipelineRunStateLabel } from './pipeline-run-labels'

export function PipelineOwnerRequestDetails({
  selected,
  detail
}: {
  selected: PipelineOwnerProposalRead
  detail?: PipelineOwnerProposalDetails
}) {
  const t = useTranslate()
  const locale = useIntlLocale()
  const request = selected.request
  if (!request) {
    return (
      <p className="text-sm">
        {t(
          'pipelines.requestUnavailable',
          'This request could not be found. Its action result could not be established.'
        )}
      </p>
    )
  }
  const confirmed = Boolean(selected.receipt)
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <PipelineStatusBadge
          state={
            confirmed
              ? 'completed'
              : detail?.availability === 'outdated' || detail?.availability === 'runtime_changed'
                ? 'blocked'
                : 'waiting_owner'
          }
          label={
            confirmed
              ? t('pipelines.actionApplied', 'Action confirmed')
              : detail?.availability === 'outdated'
                ? t('pipelines.requestOutdated', 'Request is outdated')
                : detail?.availability === 'runtime_changed'
                  ? t('pipelines.requestPreviousRuntime', 'Request from a previous app session')
                  : t('pipelines.yourDecisionNeeded', 'Your decision is needed')
          }
        />
        {detail?.subject && (
          <p className="text-base font-semibold">
            {detail.subject}
            {detail.stageTitle ? ` · ${detail.stageTitle}` : ''}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {new Date(request.createdAt).toLocaleString(locale)}
        </p>
      </div>
      <section className="space-y-2 border-t pt-4">
        <h3 className="text-sm font-semibold">{t('pipelines.whatHappened', 'What happened')}</h3>
        <p className="text-sm">
          {request.kind === 'decision'
            ? t('pipelines.decisionCause', 'A stage result was submitted for your review.')
            : request.kind === 'budget'
              ? t('pipelines.budgetCause', 'Higher limits were requested for this run.')
              : request.kind === 'publish'
                ? t(
                    'pipelines.publishCause',
                    'Publication of a saved template revision was requested.'
                  )
                : t(
                    'pipelines.availabilityCause',
                    'A change to this template version’s availability was requested.'
                  )}
        </p>
        {detail?.summary && (
          <p className="whitespace-pre-wrap break-words rounded-md border bg-card p-3 text-sm text-card-foreground">
            {detail.summary}
          </p>
        )}
      </section>
      <section className="space-y-2 border-t pt-4">
        <h3 className="text-sm font-semibold">
          {confirmed
            ? t('pipelines.requestedAction', 'Requested action')
            : t('pipelines.whatYouDecide', 'What you are being asked to decide')}
        </h3>
        <PipelineOwnerRequestIntent request={request} detail={detail} />
        <p className="text-sm text-muted-foreground">
          {request.kind === 'budget'
            ? t(
                'pipelines.budgetEffect',
                'Confirmation raises these limits. It does not accept a stage result or resume a paused run.'
              )
            : request.kind === 'publish'
              ? t(
                  'pipelines.publicationEffect',
                  'Confirmation makes this revision available for new tasks. Existing runs keep their template version.'
                )
              : request.kind === 'disable'
                ? t(
                    'pipelines.availabilityEffect',
                    'Confirmation changes availability for this version. Enabling it does not resume paused runs.'
                  )
                : t(
                    'pipelines.stageDecisionEffect',
                    'Confirmation applies the decision and the transition shown above.'
                  )}
        </p>
      </section>
      <section className="space-y-2 rounded-md border bg-card p-3 text-card-foreground">
        <h3 className="text-sm font-semibold">
          {t('pipelines.whatHappenedNext', 'Action result')}
        </h3>
        {selected.receipt ? (
          <>
            <p className="text-sm">
              {'selection' in selected.receipt
                ? selected.receipt.action === 'published'
                  ? t('pipelines.publishedVersionResult', 'Version {{version}} was published.', {
                      version: selected.receipt.selection.version
                    })
                  : selected.receipt.action === 'enabled'
                    ? t('pipelines.enabledVersionResult', 'Version {{version}} was enabled.', {
                        version: selected.receipt.selection.version
                      })
                    : t('pipelines.disabledVersionResult', 'Version {{version}} was disabled.', {
                        version: selected.receipt.selection.version
                      })
                : t(
                    'pipelines.recordedRunState',
                    'Run state immediately after this action: {{state}}.',
                    { state: pipelineRunStateLabel(selected.receipt.state, t) }
                  )}
            </p>
            {detail?.recordedStageTitle && (
              <p className="text-sm">
                {t('pipelines.recordedStage', 'Stage after this action: {{stage}}', {
                  stage: detail.recordedStageTitle
                })}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {t(
                'pipelines.historyDoesNotRepeat',
                'This is a record of the confirmed action. Opening it does not apply it again.'
              )}
            </p>
          </>
        ) : (
          <p className="text-sm">
            {detail?.availability === 'outdated'
              ? t(
                  'pipelines.outdatedRequestMeaning',
                  'The run or template changed after this request. It cannot be applied to the newer state. Review the current result and request a new decision if needed.'
                )
              : detail?.availability === 'runtime_changed'
                ? t(
                    'pipelines.oldRuntimeRequestMeaning',
                    'Orca restarted after this request was created. This request cannot be confirmed in the new session; review the current state first.'
                  )
                : t(
                    'pipelines.noConfirmedEffect',
                    'No confirmation is recorded. The proposed action has not been confirmed through this request.'
                  )}
          </p>
        )}
      </section>
      {detail?.template && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            {t('pipelines.relatedTemplate', 'Related template')}
          </summary>
          <div className="mt-3">
            <PipelineTemplatePreview template={detail.template} />
            {request.kind === 'publish' && (
              <PipelineLaunchPreview
                preview={detail.launchPreview}
                stages={detail.template.stages}
              />
            )}
          </div>
        </details>
      )}
    </div>
  )
}
