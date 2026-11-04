import React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { RepoForkIndicator } from '@/components/repo/repo-fork-indicator'
import type { FolderWorkspacePathStatus } from '../../../../../../shared/folder-workspaces/folder-workspace-path-status'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import { ProjectHeaderHostLabel } from './ProjectHeaderHostLabel'
import type { ProjectHeaderHostContext } from './project-header-host-context'
import type { getSidebarHeaderVisual } from './header-visuals'
import { FolderPathStatusIndicator } from './FolderPathStatusIndicator'
import { RepoScanUnavailableIndicator } from './RepoScanUnavailableIndicator'
import { CollapsedProjectSummary } from './CollapsedProjectSummary'

const EMPTY_WORKTREE_IDS: readonly string[] = []

/** Hierarchy: group = category label, project = block title, other sections = compact label. */
export type SectionHeaderTitleLevel = 'group-label' | 'project' | 'section'

export function SectionHeaderTitle({
  row,
  label,
  level,
  headerVisual,
  repoHeaderColor,
  hostContext,
  projectGroupPathStatus,
  isRepoHeader,
  isHeaderCollapsed,
  showCollapsedProjectSummary
}: {
  row: GroupHeaderRow
  label: string
  level: SectionHeaderTitleLevel
  headerVisual: ReturnType<typeof getSidebarHeaderVisual>
  repoHeaderColor: string | undefined
  hostContext: ProjectHeaderHostContext | undefined
  projectGroupPathStatus: FolderWorkspacePathStatus | null
  isRepoHeader: boolean
  isHeaderCollapsed: boolean
  showCollapsedProjectSummary: boolean
}): React.JSX.Element {
  const isGroupLabel = level === 'group-label'
  return (
    <>
      {isGroupLabel ? null : (
        <div
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-[4px]',
            repoHeaderColor ? 'text-muted-foreground' : headerVisual.tone
          )}
        >
          {row.repo ? (
            <RepoIconGlyph
              repoIcon={row.repo.repoIcon}
              color={repoHeaderColor}
              className="size-4"
              iconClassName="size-3.5"
            />
          ) : (
            <headerVisual.icon className="size-3" />
          )}
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <div
            className={cn(
              'min-w-0 truncate font-semibold',
              isGroupLabel
                ? 'text-[11px] uppercase leading-4 tracking-wider text-muted-foreground'
                : level === 'project'
                  ? 'text-sm leading-5'
                  : 'text-[13px] leading-4'
            )}
          >
            {label}
          </div>
          {hostContext ? <ProjectHeaderHostLabel context={hostContext} /> : null}
          <RepoForkIndicator upstream={row.repo?.upstream} />
          <FolderPathStatusIndicator status={projectGroupPathStatus} />
          {isRepoHeader && row.repo ? <RepoScanUnavailableIndicator repo={row.repo} /> : null}
          {isGroupLabel ? (
            <>
              <span aria-hidden className="h-px min-w-3 flex-1 bg-worktree-sidebar-border" />
              <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                {row.count}
              </span>
              {isHeaderCollapsed && row.count > 0 ? (
                <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              ) : null}
            </>
          ) : null}
          {showCollapsedProjectSummary ? (
            <CollapsedProjectSummary
              worktreeIds={row.worktreeIds ?? EMPTY_WORKTREE_IDS}
              count={row.count}
            />
          ) : null}
        </div>
      </div>
    </>
  )
}
