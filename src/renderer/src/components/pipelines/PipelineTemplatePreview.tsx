import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { PipelineV2Template } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'

export function PipelineTemplatePreview({
  template,
  onClose
}: {
  template: PipelineV2Template
  onClose?: () => void
}) {
  const t = useTranslate()
  const title = (id: string) => template.stages.find((stage) => stage.id === id)?.title ?? id
  return (
    <section className="space-y-3 rounded-md border p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold">
          {template.title} · {template.version}
        </h3>
        {onClose && (
          <Button variant="ghost" onClick={onClose}>
            {t('pipelines.closePreview', 'Close preview')}
          </Button>
        )}
      </div>
      <p className="text-sm">{template.description}</p>
      <ol className="space-y-2">
        {template.stages.map((stage) => (
          <li key={stage.id} className="rounded-md border p-3">
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                {stage.title}
                {stage.ownerGate.enabled ? ` · ${t('pipelines.waitsForYou', 'Waits for you')}` : ''}
              </summary>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm">{stage.instructions}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {stage.kind === 'agent'
                  ? [
                      stage.executor.agent,
                      stage.executor.model.kind === 'explicit'
                        ? stage.executor.model.id
                        : t('pipelines.default', 'Agent default'),
                      stage.executor.effort,
                      stage.executor.surface,
                      stage.executor.session.kind,
                      stage.executor.permissionMode
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : stage.executor.checkIds.join(', ')}
              </p>
              {stage.ownerGate.enabled && (
                <p className="text-xs text-muted-foreground">
                  {t('pipelines.reworkTo', 'Request changes → {{stage}}', {
                    stage: title(stage.ownerGate.reworkTargetStageId)
                  })}
                </p>
              )}
              <ul className="mt-2 space-y-1 text-xs">
                {stage.outcomes.map((outcome) => (
                  <li key={outcome.id}>
                    {outcome.title} →{' '}
                    {outcome.target.kind === 'stage'
                      ? title(outcome.target.stageId)
                      : outcome.target.kind === 'finish'
                        ? t('pipelines.finish', 'Finish workflow')
                        : t('pipelines.next', 'Next in the list')}
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ol>
    </section>
  )
}
