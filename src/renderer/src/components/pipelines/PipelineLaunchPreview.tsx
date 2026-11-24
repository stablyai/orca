import { useTranslate } from '@/i18n/use-translate'
import type { PipelineV2TemplateShowResult } from '../../../../shared/pipelines/v2/pipeline-v2-library-results'

export function PipelineLaunchPreview({
  preview,
  stages
}: {
  preview: PipelineV2TemplateShowResult['launchPreview']
  stages: { id: string; title: string }[]
}) {
  const t = useTranslate()
  const reasons: Record<string, string> = {
    pipeline_agent_unavailable: t(
      'pipelines.launchAgentUnavailable',
      'This agent is unavailable. Check its account and runtime.'
    ),
    pipeline_surface_unavailable: t(
      'pipelines.launchSurfaceUnavailable',
      'This agent cannot use the selected Chat or terminal surface.'
    ),
    pipeline_model_unavailable: t(
      'pipelines.launchModelUnavailable',
      'The selected model is unavailable or its catalog could not be verified.'
    ),
    pipeline_effort_unavailable: t(
      'pipelines.launchEffortUnavailable',
      'The selected effort is unavailable for this model and surface.'
    ),
    pipeline_permission_mode_unsupported: t(
      'pipelines.launchPermissionsUnavailable',
      'This permission mode cannot be verified for the selected agent and surface.'
    ),
    pipeline_model_transport_unavailable: t(
      'pipelines.launchTransportUnavailable',
      'The native launch transport cannot apply this model.'
    ),
    pipeline_fresh_session_required: t(
      'pipelines.launchFreshRequired',
      'Remove inherited resume or fork arguments before starting a fresh session.'
    )
  }
  if (!preview) {
    return null
  }
  return (
    <section className="space-y-2 rounded-md border p-3">
      <h4 className="text-sm font-medium">
        {t('pipelines.effectivePreview', 'Current launch choices')}
      </h4>
      <p className="text-xs text-muted-foreground">
        {t(
          'pipelines.effectivePreviewMeaning',
          'These choices are checked again and pinned when the workspace is created.'
        )}
      </p>
      <ul className="space-y-2">
        {preview.map((item) => (
          <li key={item.stageId} className="text-sm">
            <span className="font-medium">
              {stages.find((stage) => stage.id === item.stageId)?.title ?? item.stageId}
            </span>
            <p className="break-words text-xs text-muted-foreground">
              {item.state === 'available'
                ? [
                    item.executor.agent,
                    item.executor.model,
                    item.executor.effort,
                    item.executor.surface
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : (reasons[item.reason ?? ''] ??
                  t(
                    'pipelines.launchUnavailable',
                    'Launch choices could not be verified. Check agent availability and choose an available model before creating a workspace.'
                  ))}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}
