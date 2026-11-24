import { useTranslate } from '@/i18n/use-translate'
import type { PipelineV2Stage } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import { PipelineTextField, PipelineSelectField, PipelineToggle } from './PipelineFormFields'
import { PipelineExecutorEditor } from './PipelineExecutorEditor'
import { PipelineTransitionEditor } from './PipelineTransitionEditor'
const emptyChecks: string[] = []

export function PipelineStageEditor({
  stage,
  stages,
  workspacePath,
  checks = emptyChecks,
  onChange
}: {
  stage: PipelineV2Stage
  stages: PipelineV2Stage[]
  workspacePath?: string
  checks?: string[]
  onChange: (stage: PipelineV2Stage) => void
}) {
  const t = useTranslate()
  return (
    <div className="space-y-5">
      <PipelineTextField
        label={t('pipelines.stageName', 'Stage name')}
        value={stage.title}
        maxLength={120}
        onChange={(title) => onChange({ ...stage, title })}
      />
      <PipelineTextField
        label={t('pipelines.instructions', 'Instructions')}
        value={stage.instructions}
        multiline
        onChange={(instructions) => onChange({ ...stage, instructions })}
      />
      <PipelineTextField
        label={t('pipelines.expectedResult', 'Expected result')}
        value={stage.expectedResult}
        multiline
        onChange={(expectedResult) => onChange({ ...stage, expectedResult })}
      />
      <p className="text-xs text-muted-foreground">
        {JSON.stringify(stage.instructions).length + JSON.stringify(stage.expectedResult).length} /
        6000
      </p>
      {stage.kind === 'agent' ? (
        <>
          <PipelineExecutorEditor
            executor={stage.executor}
            workspacePath={workspacePath}
            onChange={(executor) => onChange({ ...stage, executor })}
          />
          <PipelineSelectField
            label={t('pipelines.evidence', 'Result evidence')}
            value={stage.evidenceSchema}
            options={[
              { value: 'generic', label: t('pipelines.genericResult', 'Explained result') },
              { value: 'plan', label: t('pipelines.planResult', 'Implementation plan') },
              {
                value: 'changes',
                label: t('pipelines.changesResult', 'Source changes and verification')
              },
              { value: 'review', label: t('pipelines.reviewResult', 'Review findings') },
              {
                value: 'docs',
                label: t('pipelines.docsResult', 'Documentation or a reason no update is needed')
              }
            ]}
            onChange={(evidenceSchema) => {
              if (
                evidenceSchema === 'generic' ||
                evidenceSchema === 'plan' ||
                evidenceSchema === 'changes' ||
                evidenceSchema === 'review' ||
                evidenceSchema === 'docs'
              ) {
                onChange({ ...stage, evidenceSchema })
              }
            }}
          />
          <PipelineToggle
            checked={stage.independent}
            onChange={(independent) =>
              onChange({
                ...stage,
                independent
              })
            }
          >
            {t(
              'pipelines.independentSession',
              'Require a session separate from implementation context'
            )}
          </PipelineToggle>
        </>
      ) : (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">
            {t('pipelines.configuredChecks', 'Project checks')}
          </h4>
          {[...new Set([...checks, ...stage.executor.checkIds])].map((id) => (
            <PipelineToggle
              key={id}
              checked={stage.executor.checkIds.includes(id)}
              onChange={(checked) =>
                onChange({
                  ...stage,
                  executor: {
                    checkIds: checked
                      ? [...stage.executor.checkIds, id]
                      : stage.executor.checkIds.filter((value) => value !== id)
                  }
                })
              }
            >
              {id}
              {!checks.includes(id) ? ` · ${t('pipelines.unconfigured', 'Not configured')}` : ''}
            </PipelineToggle>
          ))}
          {checks.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {t(
                'pipelines.noChecks',
                'Configure trusted project checks before publishing a pipeline with check stages.'
              )}
            </p>
          )}
        </div>
      )}
      <div className="space-y-3 rounded-md border p-3">
        <PipelineToggle
          checked={stage.ownerGate.enabled}
          onChange={(enabled) => onChange({ ...stage, ownerGate: { ...stage.ownerGate, enabled } })}
        >
          {t('pipelines.waitOwner', 'Wait for my decision after this stage')}
        </PipelineToggle>
        {stage.ownerGate.enabled && (
          <>
            <p className="text-xs text-muted-foreground">
              {t(
                'pipelines.discussInSession',
                'Discuss the result in the agent session. Continue or request changes with an explicit decision.'
              )}
            </p>
            <PipelineSelectField
              label={t('pipelines.reworkTarget', 'When I request changes, return to')}
              value={stage.ownerGate.reworkTargetStageId}
              options={stages.map((stage) => ({ value: stage.id, label: stage.title }))}
              onChange={(reworkTargetStageId) =>
                onChange({ ...stage, ownerGate: { ...stage.ownerGate, reworkTargetStageId } })
              }
            />
          </>
        )}
        <PipelineTextField
          label={t('pipelines.reentries', 'Maximum returns to this stage (0–10)')}
          value={String(stage.maxReentries)}
          onChange={(value) =>
            onChange({ ...stage, maxReentries: value === '' ? 0 : Number(value) })
          }
        />
      </div>
      <details className="space-y-3">
        <summary className="cursor-pointer text-sm font-medium">
          {t('pipelines.inputs', 'Context for this stage')}
        </summary>
        <PipelineToggle
          checked={stage.inputs.task}
          onChange={(task) => onChange({ ...stage, inputs: { ...stage.inputs, task } })}
        >
          {t('pipelines.includeTask', 'Include the original task')}
        </PipelineToggle>
        {stages
          .filter((value) => value.id !== stage.id)
          .map((value) => (
            <PipelineToggle
              key={value.id}
              checked={stage.inputs.stageIds.includes(value.id)}
              onChange={(checked) =>
                onChange({
                  ...stage,
                  inputs: {
                    ...stage.inputs,
                    stageIds: checked
                      ? [...stage.inputs.stageIds, value.id]
                      : stage.inputs.stageIds.filter((id) => id !== value.id)
                  }
                })
              }
            >
              {value.title}
            </PipelineToggle>
          ))}
      </details>
      <PipelineTransitionEditor stage={stage} stages={stages} onChange={onChange} />
    </div>
  )
}
