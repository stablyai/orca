import { ExternalLink, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { AutomationRunRerunButton } from './AutomationRunRerunButton'

export function AutomationRunToolbar({
  workspaceActionLabel,
  onOpenWorkspace,
  onRerun,
  onEdit,
  isRerunPending,
  isModelFixPending
}: {
  workspaceActionLabel: string | null
  onOpenWorkspace: () => void
  onRerun?: () => void
  onEdit?: () => void
  isRerunPending: boolean
  isModelFixPending: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const editLabel = t('automations.runPage.editAutomation', 'Edit automation')
  if (!workspaceActionLabel && !onRerun && !onEdit) {
    return null
  }
  return (
    <div className="@container flex min-w-0 items-center gap-2">
      {workspaceActionLabel ? (
        <Button type="button" size="sm" className="min-w-0" onClick={onOpenWorkspace}>
          <ExternalLink className="size-3.5" />
          <span className="truncate">{workspaceActionLabel}</span>
        </Button>
      ) : null}
      {onRerun ? (
        <AutomationRunRerunButton pending={isRerunPending || isModelFixPending} onRerun={onRerun} />
      ) : null}
      {onEdit ? (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 @max-[25rem]:hidden"
            aria-label={editLabel}
            disabled={isModelFixPending}
            onClick={onEdit}
          >
            <Pencil className="size-3.5" />
            {t('automations.runPage.edit', 'Edit')}
          </Button>
          <div className="shrink-0 @min-[25rem]:hidden">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={editLabel}
                  disabled={isModelFixPending}
                  onClick={onEdit}
                >
                  <Pencil className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {editLabel}
              </TooltipContent>
            </Tooltip>
          </div>
        </>
      ) : null}
    </div>
  )
}
