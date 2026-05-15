import React from 'react'
import { Bell, CalendarClock, Github, Gitlab, List, Search } from 'lucide-react'
import { useAppStore } from '@/store'
import { useRepoMap } from '@/store/selectors'
import { cn } from '@/lib/utils'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getTaskPresetQuery, PER_REPO_FETCH_LIMIT } from '@/lib/new-workspace'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import {
  normalizeVisibleTaskProviders,
  resolveVisibleTaskProvider
} from '../../../../shared/task-providers'

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

const SidebarNav = React.memo(function SidebarNav() {
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  const openAutomationsPage = useAppStore((s) => s.openAutomationsPage)
  const openActivityPage = useAppStore((s) => s.openActivityPage)
  const openModal = useAppStore((s) => s.openModal)
  const activeView = useAppStore((s) => s.activeView)
  const repos = useAppStore((s) => s.repos)
  const repoMap = useRepoMap()
  const canBrowseTasks = repos.some((repo) => isGitRepoKind(repo))
  // Why: the setting is opt-out (default true). `!== false` keeps the button
  // visible for users whose persisted settings predate this field.
  const showTasksButton = useAppStore((s) => s.settings?.showTasksButton !== false)
  const rawVisibleTaskProviders = useAppStore((s) => s.settings?.visibleTaskProviders)
  const defaultTaskSource = useAppStore((s) => s.settings?.defaultTaskSource ?? 'github')
  const visibleTaskProviders = React.useMemo(
    () => normalizeVisibleTaskProviders(rawVisibleTaskProviders),
    [rawVisibleTaskProviders]
  )
  const resolvedDefaultTaskSource = React.useMemo(
    () => resolveVisibleTaskProvider(defaultTaskSource, visibleTaskProviders),
    [defaultTaskSource, visibleTaskProviders]
  )

  // Why: warm the GitHub work-item cache on hover/focus so by the time the
  // user's click finishes the round-trip has either completed or is already
  // in-flight. Shaves ~200–600ms off perceived page-load latency.
  const prefetchWorkItems = useAppStore((s) => s.prefetchWorkItems)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const defaultTaskViewPreset = useAppStore((s) => s.settings?.defaultTaskViewPreset ?? 'all')
  const handlePrefetch = React.useCallback(() => {
    if (!canBrowseTasks || resolvedDefaultTaskSource !== 'github') {
      return
    }
    const activeRepo = activeRepoId ? (repoMap.get(activeRepoId) ?? null) : null
    const activeGitRepo = activeRepo && isGitRepoKind(activeRepo) ? activeRepo : null
    const firstGitRepo = activeGitRepo ?? repos.find((r) => isGitRepoKind(r))
    if (firstGitRepo?.path) {
      // Why: warm the exact cache key the page will read on mount — must
      // match TaskPage's `initialTaskQuery` derived from the same default
      // preset, otherwise the prefetch lands in a key the page never reads
      // and we pay the full round-trip after click.
      prefetchWorkItems(
        firstGitRepo.id,
        firstGitRepo.path,
        PER_REPO_FETCH_LIMIT,
        getTaskPresetQuery(defaultTaskViewPreset)
      )
    }
  }, [
    activeRepoId,
    canBrowseTasks,
    defaultTaskViewPreset,
    prefetchWorkItems,
    repoMap,
    repos,
    resolvedDefaultTaskSource
  ])

  const tasksActive = activeView === 'tasks'
  const automationsActive = activeView === 'automations'
  const activityActive = activeView === 'activity'
  const activityUnreadCount = useAppStore((s) => {
    let count = 0
    for (const worktrees of Object.values(s.worktreesByRepo)) {
      for (const worktree of worktrees) {
        if (worktree.createdAt && worktree.isUnread) {
          count += 1
        }
      }
    }
    for (const [paneKey, entry] of Object.entries(s.agentStatusByPaneKey)) {
      if (entry.state !== 'done' && entry.state !== 'blocked' && entry.state !== 'waiting') {
        continue
      }
      if ((s.acknowledgedAgentsByPaneKey[paneKey] ?? 0) < entry.stateStartedAt) {
        count += 1
      }
    }
    for (const [paneKey, retained] of Object.entries(s.retainedAgentsByPaneKey)) {
      if (retained.entry.state !== 'done') {
        continue
      }
      if ((s.acknowledgedAgentsByPaneKey[paneKey] ?? 0) < retained.entry.stateStartedAt) {
        count += 1
      }
    }
    for (const unsupported of Object.values(s.migrationUnsupportedByPtyId)) {
      const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
      if (!entry) {
        continue
      }
      if ((s.acknowledgedAgentsByPaneKey[entry.paneKey] ?? 0) < entry.stateStartedAt) {
        count += 1
      }
    }
    return count
  })

  return (
    <div className="flex flex-col gap-0.5 px-2 pt-2 pb-1">
      {showTasksButton ? (
        <button
          type="button"
          onClick={() => {
            if (!canBrowseTasks) {
              return
            }
            openTaskPage()
          }}
          onPointerEnter={handlePrefetch}
          onFocus={handlePrefetch}
          disabled={!canBrowseTasks}
          aria-current={tasksActive ? 'page' : undefined}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
            tasksActive
              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
              : 'text-sidebar-foreground/60 hover:bg-sidebar-foreground/8',
            !canBrowseTasks && 'cursor-not-allowed opacity-50 hover:bg-transparent'
          )}
        >
          <List
            className={cn('size-4 shrink-0', !tasksActive && 'text-sidebar-foreground/30')}
            strokeWidth={tasksActive ? 2.25 : 1.75}
          />
          <span className="flex-1">Tasks</span>
          <span className="flex items-center gap-1">
            {visibleTaskProviders.includes('github') ? (
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!canBrowseTasks) {
                    return
                  }
                  openTaskPage({ taskSource: 'github' })
                }}
                className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:text-foreground"
                aria-label="Open GitHub tasks"
              >
                <Github className="size-3.5" aria-hidden />
              </span>
            ) : null}
            {visibleTaskProviders.includes('gitlab') ? (
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!canBrowseTasks) {
                    return
                  }
                  openTaskPage({ taskSource: 'gitlab' })
                }}
                className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:text-foreground"
                aria-label="Open GitLab tasks"
              >
                <Gitlab className="size-3.5" aria-hidden />
              </span>
            ) : null}
            {visibleTaskProviders.includes('linear') ? (
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!canBrowseTasks) {
                    return
                  }
                  openTaskPage({ taskSource: 'linear' })
                }}
                className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:text-foreground"
                aria-label="Open Linear tasks"
              >
                <LinearIcon className="size-3.5" />
              </span>
            ) : null}
          </span>
        </button>
      ) : null}
      <button
        type="button"
        onClick={openAutomationsPage}
        aria-current={automationsActive ? 'page' : undefined}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
          automationsActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground/60 hover:bg-sidebar-foreground/8'
        )}
      >
        <CalendarClock
          className={cn('size-4 shrink-0', !automationsActive && 'text-sidebar-foreground/30')}
          strokeWidth={automationsActive ? 2.25 : 1.75}
        />
        <span className="flex-1">Automations</span>
      </button>
      <button
        type="button"
        onClick={openActivityPage}
        aria-current={activityActive ? 'page' : undefined}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
          activityActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground/60 hover:bg-sidebar-foreground/8'
        )}
      >
        <Bell
          className={cn('size-4 shrink-0', !activityActive && 'text-sidebar-foreground/30')}
          strokeWidth={activityActive ? 2.25 : 1.75}
        />
        <span className="flex-1">Agents</span>
        {activityUnreadCount > 0 ? (
          <span className="rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground">
            {activityUnreadCount}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        onClick={() => openModal('worktree-palette')}
        aria-label="Search worktrees and browser tabs"
        className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight text-sidebar-foreground/60 transition-colors hover:bg-sidebar-foreground/8"
      >
        <Search className="size-4 shrink-0 text-sidebar-foreground/30" strokeWidth={1.75} />
        <span className="flex-1">Search</span>
        <kbd className="hidden rounded border border-border/60 bg-background/40 px-1.5 py-px font-mono text-[10px] font-medium text-muted-foreground group-hover:inline-flex items-center">
          {isMac ? '⌘J' : 'Ctrl+Shift+J'}
        </kbd>
      </button>
    </div>
  )
})

export default SidebarNav
