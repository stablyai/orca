import { useTranslate } from '@/i18n/use-translate'
import type { PipelineV2Template } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import { PipelineTextField, PipelineSelectField, PipelineToggle } from './PipelineFormFields'
import { pipelineV2ReviewRequirements } from '../../../../shared/pipelines/v2/pipeline-v2-review-policy'

export function PipelineCompletionEditor({
  template,
  onChange
}: {
  template: PipelineV2Template
  onChange: (patch: Partial<PipelineV2Template>) => void
}) {
  const t = useTranslate()
  const policy = template.completionPolicy
  return (
    <details className="space-y-3 rounded-md border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        {t('pipelines.completion', 'Completion and limits')}
      </summary>
      <p className="text-sm text-muted-foreground">
        {t(
          'pipelines.finishTargetsMeaning',
          'Set where the workflow ends in each stage’s outcomes: choose “Finish workflow”. These settings define what must be verified at that point.'
        )}
      </p>
      <PipelineSelectField
        label={t('pipelines.finishRequirements', 'Requirements at the finish')}
        value={policy.kind}
        options={[
          {
            value: 'workflow_complete',
            label: t('pipelines.workflowComplete', 'Workflow completed')
          },
          {
            value: 'reviewed_source',
            label: t('pipelines.checkedReviewedSource', 'Source checked and reviewed')
          }
        ]}
        onChange={(kind) =>
          onChange({
            completionPolicy:
              kind === 'workflow_complete'
                ? { kind }
                : {
                    kind: 'reviewed_source',
                    checkRequirements: [],
                    reviewRequirements: [],
                    repairEntryStageId: template.entryStageId
                  }
          })
        }
      />
      {policy.kind === 'workflow_complete' ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'pipelines.workflowMeaning',
            'This policy confirms the workflow finished. It does not certify code readiness.'
          )}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {t(
              'pipelines.configurableReviewRequirements',
              'Choose checks, accepted review outcomes, and whether each review must be independent or fresh. All required evidence must match the current clean source.'
            )}
          </p>
          <PipelineSelectField
            label={t('pipelines.repairEntry', 'If final source evidence is stale, return to')}
            value={policy.repairEntryStageId}
            options={template.stages.map((stage) => ({ value: stage.id, label: stage.title }))}
            onChange={(repairEntryStageId) =>
              onChange({ completionPolicy: { ...policy, repairEntryStageId } })
            }
          />
          <PipelineToggle
            checked={policy.findingPolicy === 'tracked'}
            onChange={(checked) =>
              onChange({
                completionPolicy: {
                  ...policy,
                  findingPolicy: checked ? 'tracked' : 'latest_review'
                }
              })
            }
          >
            {t(
              'pipelines.trackFindingReadiness',
              'Require important retained findings to be verified fixed or disputed with owner acknowledgment'
            )}
          </PipelineToggle>
          {template.stages
            .filter((stage) => stage.kind === 'checks')
            .map((stage) => (
              <PipelineToggle
                key={stage.id}
                checked={policy.checkRequirements.some((item) => item.stageId === stage.id)}
                onChange={(checked) =>
                  onChange({
                    completionPolicy: {
                      ...policy,
                      checkRequirements: checked
                        ? [
                            ...policy.checkRequirements,
                            { stageId: stage.id, checkIds: stage.executor.checkIds }
                          ]
                        : policy.checkRequirements.filter((item) => item.stageId !== stage.id)
                    }
                  })
                }
              >
                {t('pipelines.requireChecks', 'Require checks')}: {stage.title}
              </PipelineToggle>
            ))}
          {template.stages
            .filter((stage) => stage.kind === 'agent' && stage.evidenceSchema === 'review')
            .map((stage) => (
              <div key={stage.id} className="space-y-2">
                <span className="text-sm font-medium">{stage.title}</span>
                {policy.reviewRequirements
                  .filter((item) => item.stageId === stage.id)
                  .map((item) => (
                    <div key={item.stageId} className="space-y-2">
                      <PipelineToggle
                        checked={pipelineV2ReviewRequirements(item).independent}
                        onChange={(independent) =>
                          onChange({
                            completionPolicy: {
                              ...policy,
                              reviewRequirements: policy.reviewRequirements.map((value) =>
                                value.stageId === stage.id ? { ...value, independent } : value
                              )
                            }
                          })
                        }
                      >
                        {t('pipelines.requireIndependent', 'Require independent review')}
                      </PipelineToggle>
                      <PipelineToggle
                        checked={pipelineV2ReviewRequirements(item).freshSession}
                        onChange={(freshSession) =>
                          onChange({
                            completionPolicy: {
                              ...policy,
                              reviewRequirements: policy.reviewRequirements.map((value) =>
                                value.stageId === stage.id ? { ...value, freshSession } : value
                              )
                            }
                          })
                        }
                      >
                        {t('pipelines.requireFreshReview', 'Require a fresh review session')}
                      </PipelineToggle>
                    </div>
                  ))}
                {stage.outcomes.map((outcome) => (
                  <PipelineToggle
                    key={outcome.id}
                    checked={policy.reviewRequirements.some(
                      (item) =>
                        item.stageId === stage.id && item.acceptedOutcomeIds.includes(outcome.id)
                    )}
                    onChange={(checked) => {
                      const requirement = policy.reviewRequirements.find(
                        (item) => item.stageId === stage.id
                      )
                      const old = requirement?.acceptedOutcomeIds ?? []
                      const acceptedOutcomeIds = checked
                        ? [...old, outcome.id]
                        : old.filter((id) => id !== outcome.id)
                      onChange({
                        completionPolicy: {
                          ...policy,
                          reviewRequirements: [
                            ...policy.reviewRequirements.filter(
                              (item) => item.stageId !== stage.id
                            ),
                            ...(acceptedOutcomeIds.length
                              ? [
                                  {
                                    ...requirement,
                                    stageId: stage.id,
                                    acceptedOutcomeIds,
                                    independent:
                                      requirement?.independent ??
                                      (stage.kind === 'agent' && stage.independent),
                                    freshSession:
                                      requirement?.freshSession ??
                                      (stage.kind === 'agent' &&
                                        stage.executor.session.kind === 'fresh')
                                  }
                                ]
                              : [])
                          ]
                        }
                      })
                    }}
                  >
                    {t('pipelines.requireReviewOutcome', 'Accept review outcome')}: {outcome.title}
                  </PipelineToggle>
                ))}
              </div>
            ))}
        </>
      )}
      <div className="grid gap-3 @lg:grid-cols-2">
        <PipelineTextField
          label={t('pipelines.maxInvocations', 'Maximum agent turns (1–128)')}
          value={String(template.limits.maxInvocations)}
          onChange={(value) =>
            onChange({ limits: { ...template.limits, maxInvocations: Number(value) } })
          }
        />
        <PipelineTextField
          label={t('pipelines.maxDiscussion', 'Discussion turns per visit (1–32)')}
          value={String(template.limits.maxDiscussionTurns)}
          onChange={(value) =>
            onChange({ limits: { ...template.limits, maxDiscussionTurns: Number(value) } })
          }
        />
      </div>
    </details>
  )
}
