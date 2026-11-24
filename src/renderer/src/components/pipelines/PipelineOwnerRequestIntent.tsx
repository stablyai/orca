import { useTranslate } from '@/i18n/use-translate'
import type { PipelineV2OwnerRequest } from '../../../../shared/pipelines/v2/pipeline-v2-owner-request-contracts'
import type { PipelineOwnerProposalDetails } from './pipeline-owner-proposals'

export function PipelineOwnerRequestIntent({
  request,
  detail
}: {
  request?: PipelineV2OwnerRequest | null
  detail?: PipelineOwnerProposalDetails
}) {
  const t = useTranslate()
  return (
    <>
      {request?.kind === 'decision' && (
        <p className="whitespace-pre-wrap break-words text-sm">
          {request.input.action === 'accept'
            ? t('pipelines.acceptAndContinue', 'Accept and continue')
            : t('pipelines.requestRework', 'Request rework')}
          {' · '}
          {' → '}
          {detail?.target ??
            (request.input.action === 'accept' && request.input.pin.proposedTarget.kind === 'finish'
              ? t('pipelines.finish', 'Finish workflow')
              : t('pipelines.targetUnavailable', 'Transition details unavailable'))}
          {request.input.comment ? `\n${request.input.comment}` : ''}
        </p>
      )}
      {request?.kind === 'budget' && (
        <div className="space-y-1 text-sm">
          {request.input.extension.maxInvocations !== undefined && (
            <p>
              {t('pipelines.requestedTurns', 'Agent turns: {{count}}', {
                count: request.input.extension.maxInvocations
              })}
            </p>
          )}
          {request.input.extension.maxDiscussionTurns !== undefined && (
            <p>
              {t('pipelines.requestedDiscussions', 'Discussion turns: {{count}}', {
                count: request.input.extension.maxDiscussionTurns
              })}
            </p>
          )}
          {request.input.extension.maxReentries !== undefined && (
            <p>
              {t('pipelines.requestedReturns', 'Returns to {{stage}}: {{count}}', {
                stage: detail?.target ?? request.input.extension.stageId ?? '',
                count: request.input.extension.maxReentries
              })}
            </p>
          )}
        </div>
      )}
      {request?.kind === 'disable' && (
        <p className="text-sm">
          {request.input.enabled
            ? t('pipelines.enableRequestedVersion', 'Enable this exact version')
            : t('pipelines.disableRequestedVersion', 'Disable this exact version')}
        </p>
      )}
    </>
  )
}
