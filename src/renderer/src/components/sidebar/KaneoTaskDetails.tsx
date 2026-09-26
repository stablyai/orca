import { KanbanSquare } from 'lucide-react'
import type { WorkspaceLinkedItem } from '../../../../shared/worktree/types'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function KaneoTaskDetails({
  item
}: {
  item: WorkspaceLinkedItem | null | undefined
}): React.JSX.Element | null {
  if (item?.provider !== 'kaneo') {
    return null
  }
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        {translate('kaneo.name', 'Kaneo')}
        {item.number ? ` #${item.number}` : ''}
      </p>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto max-w-full justify-start p-0 text-left whitespace-normal"
        onClick={() => void window.api.shell.openUrl(item.url)}
      >
        <KanbanSquare className="size-3.5 shrink-0" />
        {item.title}
      </Button>
    </div>
  )
}
