import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { WorkspacePane, WindowPaneLayout } from '../../../../shared/window-pane-types'
import { RepoIconGlyph } from '../repo/repo-icon'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { projectPaneContext } from './project-pane-context'
import { ProjectAccentMark } from '../repo/ProjectAccentMark'

export function ProjectPaneContext({
  pane,
  layout
}: {
  pane: WorkspacePane
  layout: WindowPaneLayout
}) {
  const context = useAppStore(
    useShallow((state) =>
      projectPaneContext(state, layout.views[pane.selectedViewId ?? ''] ?? pane.workspace)
    )
  )
  const active = layout.activePaneId === pane.id
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            tabIndex={0}
            aria-label={context.label}
            data-pane-context
            className={`flex min-w-0 flex-1 items-center gap-1.5 ${active ? 'font-medium text-foreground' : ''}`}
          >
            <ProjectAccentMark color={context.accentColor} />
            <RepoIconGlyph
              repoIcon={context.repoIcon}
              className="size-3.5 shrink-0"
              iconClassName="size-3.5"
            />
            <span className="truncate text-foreground/90">
              {[
                context.projectName,
                context.workspace !== context.projectName && context.workspace,
                context.session
              ]
                .filter(Boolean)
                .join(' / ')}
            </span>
            <span className="truncate rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {context.hostName}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-80 break-words">{context.label}</TooltipContent>
      </Tooltip>
      {context.availability && <span className="truncate">{context.availability}</span>}
      {active && (
        <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-foreground">
          Active
        </span>
      )}
    </div>
  )
}
