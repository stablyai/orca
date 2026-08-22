import type { LinearProjectSummary } from '../../../shared/types'

import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

type LinearIssueProjectLabelProps = {
  project?: LinearProjectSummary
  className?: string
}

export function LinearIssueProjectLabel({
  project,
  className
}: LinearIssueProjectLabelProps): React.JSX.Element {
  return (
    <div
      data-slot="linear-issue-project-label"
      className={cn('flex min-w-0 items-center gap-1.5 text-muted-foreground', className)}
    >
      {project ? (
        <>
          <span
            data-slot="linear-issue-project-marker"
            aria-hidden
            className="size-2 shrink-0 rounded-full bg-muted"
            style={project.color ? { backgroundColor: project.color } : undefined}
          />
          <span className="min-w-0 truncate">{project.name}</span>
        </>
      ) : (
        <span className="min-w-0 truncate">
          {translate('auto.components.TaskPage.1742eafc14', 'No Project')}
        </span>
      )}
    </div>
  )
}
