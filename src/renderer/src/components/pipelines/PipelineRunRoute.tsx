import { ArrowRight } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { PipelineRunRead } from './pipeline-run-read'
import { PipelineStatusBadge } from './PipelineStatusBadge'

export function PipelineRunRoute({ read }: { read: PipelineRunRead }) {
  const t = useTranslate()
  return (
    <nav aria-label={t('pipelines.actualRoute', 'Route taken')} className="space-y-3">
      <h2 className="text-sm font-semibold">{t('pipelines.actualRoute', 'Route taken')}</h2>
      <ol className="flex flex-wrap items-center gap-2">
        {read.visits.map((visit, index) => (
          <li key={visit.id} className="flex max-w-full items-center gap-2">
            {index > 0 && (
              <ArrowRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
            )}
            <a
              className="max-w-full rounded-md focus-visible:outline focus-visible:outline-ring"
              href={`#pipeline-attempt-${encodeURIComponent(visit.id)}`}
            >
              <PipelineStatusBadge
                state={visit.decision?.action === 'rework' ? 'rework' : visit.state}
                label={`${index + 1}. ${read.definition.stages.find((stage) => stage.id === visit.stageId)?.title ?? visit.stageId}`}
              />
            </a>
          </li>
        ))}
      </ol>
    </nav>
  )
}
