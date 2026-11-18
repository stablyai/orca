import { ChevronRight, FolderTree } from 'lucide-react'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { CollapsibleTrigger } from '@/components/ui/collapsible'
import type { RepoIcon } from '../../../../../shared/repository/appearance/repo-icon'
import { DashboardHostBadge } from '../board/DashboardHostBadge'
import { FleetAgentCount } from './FleetAgentCount'
import { FleetBucketCountChips } from './FleetBucketCountChips'
import type { FleetProject } from './fleet-view-model'

export function FleetProjectHeader({
  project,
  repoIcon
}: {
  project: FleetProject
  repoIcon: RepoIcon | null | undefined
}): React.JSX.Element {
  return (
    <h2 className="flex min-w-0">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-xl px-3 py-2.5 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[state=open]:rounded-b-none"
        >
          <ChevronRight
            className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
            aria-hidden
          />
          <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
            {!repoIcon && project.workspaceKind === 'folder' ? (
              <FolderTree className="size-3.5" aria-hidden />
            ) : (
              <RepoIconGlyph repoIcon={repoIcon} className="size-4" iconClassName="size-3.5" />
            )}
          </span>
          <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
            {project.repoName}
          </span>
          {project.hostLabel ? (
            <span className="flex min-w-0 max-w-1/3 shrink items-center gap-1 text-2xs text-muted-foreground">
              <DashboardHostBadge
                hostKind={project.hostKind}
                executionHostId={project.executionHostId}
                hostLabel={project.hostLabel}
              />
              <span className="truncate">{project.hostLabel}</span>
            </span>
          ) : null}
          <FleetAgentCount count={project.agents} />
          <span className="ml-auto shrink-0">
            <FleetBucketCountChips counts={project.counts} />
          </span>
        </button>
      </CollapsibleTrigger>
    </h2>
  )
}
