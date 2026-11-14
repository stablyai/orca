import { ExternalLink, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { PlaneIssue } from '../../../../../shared/plane-types'

export function PlaneIssueRow({
  issue,
  onOpenInWorktree
}: {
  issue: PlaneIssue
  onOpenInWorktree: (issue: PlaneIssue) => void
}): React.JSX.Element {
  const stateColor = issue.state?.color || '#808080'

  return (
    <div className="group flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-muted/30">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="shrink-0 font-mono text-xs font-semibold text-muted-foreground">
          {issue.key}
        </span>
        <span className="truncate text-xs font-medium text-foreground">{issue.title}</span>
        <Badge
          variant="outline"
          className="shrink-0 gap-1.5 border-transparent text-[11px] font-normal"
          style={{ backgroundColor: `${stateColor}18`, color: stateColor }}
        >
          <span className="size-1.5 rounded-full" style={{ backgroundColor: stateColor }} />
          {issue.state?.name || translate('auto.components.task.page.plane.backlog', 'Backlog')}
        </Badge>
        {issue.priority && issue.priority !== 'none' && (
          <Badge variant="secondary" className="shrink-0 capitalize text-[10px]">
            {issue.priority}
          </Badge>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2.5 text-xs font-medium"
          onClick={() => onOpenInWorktree(issue)}
        >
          <Plus className="size-3" />
          {translate('auto.components.task.page.plane.openInWorktree', 'Open in Worktree')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => void window.api.shell.openUrl(issue.url)}
          title={translate('auto.components.task.page.plane.viewInPlane', 'View in Plane')}
        >
          <ExternalLink className="size-3.5 text-muted-foreground group-hover:text-foreground" />
        </Button>
      </div>
    </div>
  )
}
