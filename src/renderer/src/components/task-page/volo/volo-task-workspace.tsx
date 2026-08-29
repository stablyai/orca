import { ExternalLink, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { VoloBoard, VoloTask } from '../../../../../shared/volo-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export function VoloTaskWorkspace({
  task,
  board,
  onUse,
  onClose,
  onMove
}: {
  task: VoloTask | null
  board: VoloBoard | null
  onUse: (task: VoloTask) => void
  onClose: () => void
  onMove: (task: VoloTask, columnId: string) => Promise<void>
  sourceContext: TaskSourceContext | null
}): React.JSX.Element | null {
  if (!task) {
    return null
  }

  return (
    <div className="flex max-h-[45%] flex-none flex-col border-t border-border/50 bg-muted/20">
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {task.taskCode}
          </p>
          <h2 className="mt-1 truncate text-sm font-medium text-foreground">{task.title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => void window.api.shell.openUrl(task.url)}
            aria-label={translate('auto.components.TaskPage.voloOpenExternal', 'Open in Volo')}
          >
            <ExternalLink className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onClose}
            aria-label={translate('auto.components.TaskPage.1a06219d5c', 'Close tasks')}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
        {board ? (
          <Select value={task.columnId} onValueChange={(columnId) => void onMove(task, columnId)}>
            <SelectTrigger className="h-8 w-[180px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {board.columns.map((column) => (
                <SelectItem key={column.id} value={column.id}>
                  {column.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <span className="text-xs text-muted-foreground">{task.assigneeName ?? 'Unassigned'}</span>
        <span className="text-xs text-muted-foreground">{task.priority}</span>
        <Button type="button" size="sm" onClick={() => onUse(task)}>
          {translate('auto.components.TaskPage.voloStartWorkspace', 'Start workspace')}
        </Button>
      </div>
      {task.description ? (
        <div className="max-h-40 overflow-y-auto scrollbar-sleek px-4 pb-4 text-sm text-muted-foreground whitespace-pre-wrap">
          {task.description}
        </div>
      ) : null}
    </div>
  )
}
