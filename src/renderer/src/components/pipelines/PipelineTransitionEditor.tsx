import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { PipelineV2Stage } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import { PipelineTextField, PipelineSelectField } from './PipelineFormFields'

export function PipelineTransitionEditor({
  stage,
  stages,
  onChange
}: {
  stage: PipelineV2Stage
  stages: PipelineV2Stage[]
  onChange: (stage: PipelineV2Stage) => void
}) {
  const t = useTranslate()
  const update = (index: number, patch: Partial<PipelineV2Stage['outcomes'][number]>) =>
    onChange({
      ...stage,
      outcomes: stage.outcomes.map((outcome, at) =>
        at === index ? { ...outcome, ...patch } : outcome
      )
    })
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">
        {t('pipelines.transitions', 'Outcomes and transitions')}
      </h4>
      <p className="text-xs text-muted-foreground">
        {stage.kind === 'checks'
          ? t(
              'pipelines.binaryChecksMeaning',
              'Automatic checks report pass or fail. Choose a destination for each result; additional outcomes are available on agent stages.'
            )
          : t(
              'pipelines.agentCriteriaMeaning',
              'The agent chooses a named outcome using these instructions. A destination can continue, return to a stage, or finish the workflow. Conditions are text instructions, not executable expressions.'
            )}
      </p>
      {stage.outcomes.map((outcome, index) => (
        <div key={outcome.id} className="space-y-3 rounded-md border p-3">
          <PipelineTextField
            label={t('pipelines.outcome', 'Outcome')}
            value={outcome.title}
            maxLength={120}
            onChange={(title) => update(index, { title })}
          />
          {stage.kind === 'agent' && (
            <PipelineTextField
              label={t('pipelines.criterion', 'When this condition is met')}
              value={outcome.criterion}
              maxLength={500}
              multiline
              onChange={(criterion) => update(index, { criterion })}
            />
          )}
          <PipelineSelectField
            label={t('pipelines.goTo', 'Go to')}
            value={
              outcome.target.kind === 'stage'
                ? `stage:${outcome.target.stageId}`
                : outcome.target.kind
            }
            options={[
              { value: 'next', label: t('pipelines.next', 'Next in the list') },
              { value: 'finish', label: t('pipelines.finish', 'Finish workflow') },
              ...stages.map((stage) => ({ value: `stage:${stage.id}`, label: stage.title }))
            ]}
            onChange={(target) =>
              update(index, {
                target: target.startsWith('stage:')
                  ? { kind: 'stage', stageId: target.slice(6) }
                  : target === 'finish'
                    ? { kind: 'finish' }
                    : { kind: 'next' }
              })
            }
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={
              stage.outcomes.length === 1 ||
              (stage.kind === 'checks' && Object.values(stage.checkOutcomeMap).includes(outcome.id))
            }
            onClick={() =>
              onChange({
                ...stage,
                outcomes: stage.outcomes.filter((value) => value.id !== outcome.id)
              })
            }
          >
            {t('pipelines.removeOutcome', 'Remove outcome')}
          </Button>
        </div>
      ))}
      {stage.kind === 'agent' && (
        <Button
          variant="outline"
          size="sm"
          disabled={stage.outcomes.length >= 8}
          onClick={() =>
            onChange({
              ...stage,
              outcomes: [
                ...stage.outcomes,
                {
                  id: `outcome-${createBrowserUuid()}`,
                  title: t('pipelines.customOutcome', 'Custom outcome'),
                  criterion: '',
                  target: { kind: 'next' }
                }
              ]
            })
          }
        >
          {t('pipelines.addOutcome', 'Add outcome')}
        </Button>
      )}
      {stage.kind === 'checks' && (
        <div className="grid gap-3 @lg:grid-cols-2">
          {(['passed', 'failed'] as const).map((result) => (
            <PipelineSelectField
              key={result}
              label={
                result === 'passed'
                  ? t('pipelines.checksPassed', 'When checks pass')
                  : t('pipelines.checksFailed', 'When checks fail')
              }
              value={stage.checkOutcomeMap[result]}
              options={stage.outcomes.map((outcome) => ({
                value: outcome.id,
                label: outcome.title
              }))}
              onChange={(id) => {
                const other = result === 'passed' ? 'failed' : 'passed'
                onChange({
                  ...stage,
                  checkOutcomeMap: {
                    ...stage.checkOutcomeMap,
                    [result]: id,
                    [other]:
                      id === stage.checkOutcomeMap[other]
                        ? stage.checkOutcomeMap[result]
                        : stage.checkOutcomeMap[other]
                  }
                })
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
