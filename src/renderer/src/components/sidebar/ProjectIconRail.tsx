import React, { useMemo } from 'react'
import { ChevronsLeft, Folder, PanelLeftOpen, Settings } from 'lucide-react'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { useWorktreeActivityStatuses } from './use-worktree-activity-statuses'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { resolveRepoHeaderColor } from './project-header-color'
import { FilledBellIcon } from './WorktreeCardHelpers'
import { AgentWorkingSpinner } from '@/components/AgentWorkingSpinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeStatus } from '@/lib/worktree-status'

export type ProjectRailStatus = 'running' | 'completed' | 'idle'

export type ProjectRailSummary = {
  status: ProjectRailStatus
  runningCount: number
  unreadCount: number
  totalCount: number
}

export function computeProjectRailSummary(
  worktrees: readonly Worktree[],
  statuses: Map<string, WorktreeStatus>
): ProjectRailSummary {
  let runningCount = 0
  let unreadCount = 0

  for (const w of worktrees) {
    const s = statuses.get(w.id)
    if (s === 'working' || s === 'monitoring' || s === 'permission') {
      runningCount++
    }
    if (w.isUnread || s === 'done') {
      unreadCount++
    }
  }

  let status: ProjectRailStatus = 'idle'
  if (runningCount > 0) {
    status = 'running'
  } else if (unreadCount > 0) {
    status = 'completed'
  } else {
    status = 'idle'
  }

  return {
    status,
    runningCount,
    unreadCount,
    totalCount: worktrees.length
  }
}

type ProjectRailItemProps = {
  repo: Repo
  worktrees: readonly Worktree[]
  statuses: Map<string, WorktreeStatus>
  isActiveProject: boolean
  onActivate: (repo: Repo) => void
  onExpand: () => void
}

const ProjectRailItem = React.memo(function ProjectRailItem({
  repo,
  worktrees,
  statuses,
  isActiveProject,
  onActivate,
  onExpand
}: ProjectRailItemProps) {
  const summary = useMemo(
    () => computeProjectRailSummary(worktrees, statuses),
    [worktrees, statuses]
  )

  const statusLabel = useMemo(() => {
    if (summary.status === 'running') {
      return translate(
        'auto.components.sidebar.ProjectIconRail.running',
        'Running ({{count}} active)',
        { count: summary.runningCount }
      )
    }
    if (summary.status === 'completed') {
      return translate(
        'auto.components.sidebar.ProjectIconRail.completed',
        'Completed ({{count}} unread)',
        { count: summary.unreadCount }
      )
    }
    return translate('auto.components.sidebar.ProjectIconRail.idle', 'Idle')
  }, [summary])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onActivate(repo)}
          onDoubleClick={onExpand}
          className={cn(
            'group relative flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors',
            'hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            isActiveProject
              ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground ring-1 ring-worktree-sidebar-ring/60'
              : 'text-muted-foreground'
          )}
          aria-label={`${repo.displayName} - ${statusLabel}`}
          data-project-rail-item={repo.id}
          data-project-rail-status={summary.status}
        >
          {repo.repoIcon ? (
            <RepoIconGlyph
              repoIcon={repo.repoIcon}
              color={resolveRepoHeaderColor(repo.badgeColor)}
              className="size-5"
              iconClassName="size-4"
            />
          ) : (
            <Folder className="size-4" style={{ color: resolveRepoHeaderColor(repo.badgeColor) }} />
          )}

          {/* Status Badge in bottom-right corner */}
          <span
            className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center pointer-events-none"
            data-project-rail-badge={summary.status}
          >
            {summary.status === 'running' ? (
              <span className="relative flex size-2.5 items-center justify-center">
                <AgentWorkingSpinner className="size-2.5" />
              </span>
            ) : summary.status === 'completed' ? (
              <FilledBellIcon className="size-3 text-workspace-status-progress drop-shadow-xs" />
            ) : (
              <span className="size-1.5 rounded-full bg-muted-foreground/40 ring-1 ring-worktree-sidebar" />
            )}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={12} className="flex flex-col gap-0.5 text-xs">
        <div className="font-semibold text-foreground">{repo.displayName}</div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          {summary.status === 'running' ? (
            <span className="size-1.5 rounded-full bg-workspace-status-review" />
          ) : summary.status === 'completed' ? (
            <FilledBellIcon className="size-2.5 text-workspace-status-progress" />
          ) : (
            <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          )}
          <span>{statusLabel}</span>
        </div>
        <div className="mt-0.5 text-[10px] text-muted-foreground/70">
          {translate(
            'auto.components.sidebar.ProjectIconRail.workspacesCount',
            '{{count}} workspace(s)',
            { count: summary.totalCount }
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
})

export function ProjectIconRail(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const allWorktrees = useAllWorktrees()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const setSidebarCollapseMode = useAppStore((s) => s.setSidebarCollapseMode)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)

  const allWorktreeIds = useMemo(() => allWorktrees.map((w) => w.id), [allWorktrees])
  const statuses = useWorktreeActivityStatuses(allWorktreeIds)

  const worktreesByRepoId = useMemo(() => {
    const map = new Map<string, Worktree[]>()
    for (const w of allWorktrees) {
      const list = map.get(w.repoId) ?? []
      list.push(w)
      map.set(w.repoId, list)
    }
    return map
  }, [allWorktrees])

  const activeRepoId = useMemo(() => {
    if (!activeWorktreeId) {
      return null
    }
    const current = allWorktrees.find((w) => w.id === activeWorktreeId)
    return current?.repoId ?? null
  }, [activeWorktreeId, allWorktrees])

  const handleActivateProject = React.useCallback(
    (repo: Repo) => {
      const projectWorktrees = worktreesByRepoId.get(repo.id) ?? []
      const isAlreadyActive = projectWorktrees.some((w) => w.id === activeWorktreeId)
      if (isAlreadyActive) {
        setSidebarOpen(true)
        return
      }

      if (projectWorktrees.length > 0) {
        const target =
          projectWorktrees.find((w) => {
            const s = statuses.get(w.id)
            return s === 'working' || s === 'monitoring' || s === 'permission'
          }) ??
          projectWorktrees.find((w) => w.isUnread) ??
          projectWorktrees.find((w) => w.isMainWorktree) ??
          projectWorktrees[0]

        if (target) {
          setActiveWorktree(target.id)
        }
      }
    },
    [worktreesByRepoId, activeWorktreeId, statuses, setActiveWorktree, setSidebarOpen]
  )

  const handleExpand = React.useCallback(() => {
    setSidebarOpen(true)
  }, [setSidebarOpen])

  return (
    <div
      data-project-icon-rail="true"
      className="flex h-full w-12 flex-col items-center justify-between py-2 bg-worktree-sidebar select-none"
    >
      {/* Top Header: Expand Sidebar Button */}
      <div className="flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleExpand}
              aria-label={translate(
                'auto.components.sidebar.ProjectIconRail.expand',
                'Expand sidebar'
              )}
              className="text-muted-foreground hover:text-foreground"
            >
              <PanelLeftOpen className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={12}>
            {translate('auto.components.sidebar.ProjectIconRail.expand', 'Expand sidebar')}
          </TooltipContent>
        </Tooltip>
        <div className="h-px w-6 bg-worktree-sidebar-border" />
      </div>

      {/* Middle: Scrollable Project Icons List */}
      <div className="flex flex-1 min-h-0 w-full flex-col items-center gap-1.5 overflow-y-auto overflow-x-hidden py-1.5 scrollbar-sleek">
        {repos.map((repo) => (
          <ProjectRailItem
            key={repo.id}
            repo={repo}
            worktrees={worktreesByRepoId.get(repo.id) ?? []}
            statuses={statuses}
            isActiveProject={repo.id === activeRepoId}
            onActivate={handleActivateProject}
            onExpand={handleExpand}
          />
        ))}
      </div>

      {/* Bottom Footer: Full Collapse & Settings Buttons */}
      <div className="flex flex-col items-center gap-1 pt-1">
        <div className="h-px w-6 bg-worktree-sidebar-border" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setSidebarCollapseMode('hidden')}
              aria-label={translate(
                'auto.components.sidebar.ProjectIconRail.hideCompletely',
                'Hide sidebar completely'
              )}
              className="text-muted-foreground hover:text-foreground"
            >
              <ChevronsLeft className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={12}>
            {translate(
              'auto.components.sidebar.ProjectIconRail.hideCompletely',
              'Hide sidebar completely'
            )}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => openSettingsPage()}
              aria-label={translate('auto.components.sidebar.ProjectIconRail.settings', 'Settings')}
              className="text-muted-foreground hover:text-foreground"
            >
              <Settings className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={12}>
            {translate('auto.components.sidebar.ProjectIconRail.settings', 'Settings')}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
