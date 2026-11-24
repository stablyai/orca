import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ArrowRight } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { PipelineV2TemplateListItem } from '../../../../shared/pipelines/v2/pipeline-v2-library-results'

export function PipelineTemplateLibrary({
  items,
  busy,
  onOpen,
  onCopy,
  onToggle,
  onDelete
}: {
  items: PipelineV2TemplateListItem[]
  busy: boolean
  onOpen: (item: PipelineV2TemplateListItem) => void
  onCopy: (item: Extract<PipelineV2TemplateListItem, { kind: 'versions' }>) => void
  onToggle: (item: Extract<PipelineV2TemplateListItem, { kind: 'versions' }>) => void
  onDelete: (item: Extract<PipelineV2TemplateListItem, { kind: 'drafts' }>) => void
}) {
  const t = useTranslate()
  return (
    <div className="space-y-2">
      {items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t('pipelines.emptyLibrary', 'No matching templates.')}
        </p>
      )}
      {items.map((item) => (
        <div
          key={item.kind === 'drafts' ? `draft:${item.id}` : item.selection.digest}
          className="space-y-3 rounded-md border p-3"
        >
          <div className="flex min-w-0 items-start gap-2">
            <Button
              variant="ghost"
              className="h-auto min-w-0 flex-1 justify-start text-left"
              disabled={busy}
              onClick={() => onOpen(item)}
            >
              <span className="min-w-0 flex-1 whitespace-normal break-words">{item.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {item.kind === 'drafts'
                  ? t('pipelines.edit', 'Edit')
                  : t('pipelines.viewTemplate', 'View')}
              </span>
              <ArrowRight className="size-4 shrink-0" />
            </Button>
            <Badge variant="secondary">
              {item.kind === 'drafts'
                ? t('pipelines.draft', 'Draft')
                : item.enabled
                  ? item.selection.version
                  : t('pipelines.disabled', 'Disabled')}
            </Badge>
          </div>
          {item.kind === 'drafts' ? (
            <div className="border-t pt-3">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDelete(item)}>
                {t('pipelines.deleteDraft', 'Delete draft')}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onCopy(item)}>
                {t('pipelines.copy', 'Copy to draft')}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onToggle(item)}>
                {item.enabled ? t('pipelines.disable', 'Disable') : t('pipelines.enable', 'Enable')}
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
