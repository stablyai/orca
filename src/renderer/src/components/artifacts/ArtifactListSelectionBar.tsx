import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

/** The toolbar's left side while rows are checked: count, the bulk action, and the way back out. */
export function ArtifactListSelectionBar({
  count,
  deleteDisabled,
  onDelete,
  onClear
}: {
  count: number
  deleteDisabled: boolean
  onDelete: () => void
  onClear: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="me-1 shrink-0 text-xs font-medium tabular-nums">
        {t('auto.components.artifacts.ArtifactListSelectionBar.selected', '{{count}} selected', {
          count,
          defaultValue_one: '{{count}} selected'
        })}
      </span>
      <Button
        type="button"
        variant="outline"
        size="toolbar"
        disabled={deleteDisabled}
        onClick={onDelete}
      >
        <Trash2 className="size-3.5" />
        {t('auto.components.artifacts.ArtifactListSelectionBar.delete', 'Delete')}
      </Button>
      <Button type="button" variant="ghost-muted" size="toolbar" onClick={onClear}>
        {t('auto.components.artifacts.ArtifactListSelectionBar.clear', 'Clear')}
      </Button>
    </div>
  )
}
