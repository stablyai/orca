import { useEffect, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { PipelineV2TemplateSelection } from '../../../../shared/pipelines/v2/pipeline-v2-template-contracts'
import type { PipelineV2TemplateShowResult } from '../../../../shared/pipelines/v2/pipeline-v2-library-results'
import type { PipelineV2Definition } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import { callPipelineRpc } from './pipeline-api'
import { PipelineLaunchPreview } from './PipelineLaunchPreview'

export function PipelineSelectionPreview({
  selection,
  runtimeId
}: {
  selection: PipelineV2TemplateSelection
  runtimeId: string
}) {
  const t = useTranslate()
  const [definition, setDefinition] = useState<PipelineV2Definition>()
  const [error, setError] = useState('')
  const [launchPreview, setLaunchPreview] =
    useState<PipelineV2TemplateShowResult['launchPreview']>()
  useEffect(() => {
    let cancelled = false
    setDefinition(undefined)
    setError('')
    void callPipelineRpc<PipelineV2TemplateShowResult>('pipeline.v2.template.show', {
      projectId: selection.projectId,
      selection,
      expectedRuntimeId: runtimeId,
      full: true
    })
      .then((result) => {
        if (!cancelled && result.record && 'definition' in result.record) {
          setDefinition(result.record.definition)
          setLaunchPreview(result.launchPreview)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setError(String(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [selection, runtimeId])
  return (
    <details className="rounded-md border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        {t('pipelines.previewStages', 'Preview stages and models')}
      </summary>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <ol className="mt-2 space-y-2">
        {definition?.stages.map((stage) => (
          <li key={stage.id} className="text-sm">
            <span className="font-medium">{stage.title}</span>
            <p className="text-xs text-muted-foreground">
              {stage.kind === 'agent'
                ? [
                    stage.executor.agent,
                    stage.executor.model.kind === 'explicit'
                      ? stage.executor.model.id
                      : t('pipelines.default', 'Agent default'),
                    stage.executor.effort,
                    stage.executor.surface
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : stage.executor.checkIds.join(', ')}
              {stage.ownerGate.enabled ? ` · ${t('pipelines.waitsForYou', 'Waits for you')}` : ''}
            </p>
          </li>
        ))}
      </ol>
      {definition && <PipelineLaunchPreview preview={launchPreview} stages={definition.stages} />}
    </details>
  )
}
