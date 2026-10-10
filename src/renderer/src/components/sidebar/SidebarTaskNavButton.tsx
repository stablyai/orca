import React from 'react'
import { EyeOff, Github, Gitlab, List } from 'lucide-react'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { LinearIcon } from '@/components/icons/LinearIcon'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { PER_REPO_FETCH_LIMIT } from '@/lib/new-workspace'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { useRepoMap } from '@/store/selectors'
import { translate } from '@/i18n/i18n'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getTaskPresetQuery } from '../../../../shared/task-preset-query'
import {
  normalizeVisibleTaskProviders,
  restoreAvailableDefaultTaskProvider,
  resolveVisibleTaskProvider
} from '../../../../shared/task-providers'

function HideTaskSidebarMenu({ onHide }: { onHide: () => void }): React.JSX.Element {
  return (
    <ContextMenuContent>
      <ContextMenuItem onSelect={onHide}>
        <EyeOff className="size-3.5" />
        {translate('auto.components.sidebar.SidebarNav.d599269755', 'Hide from sidebar')}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

function TaskProviderShortcut({
  label,
  onOpen,
  children
}: {
  label: string
  onOpen: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-worktree-sidebar-ring"
      aria-label={label}
    >
      {children}
    </button>
  )
}

export function SidebarTaskNavButton(): React.JSX.Element | null {
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const activeView = useAppStore((s) => s.activeView)
  const repos = useAppStore((s) => s.repos)
  const repoMap = useRepoMap()
  const showTasksButton = useAppStore((s) => s.settings?.showTasksButton !== false)
  const rawVisibleTaskProviders = useAppStore((s) => s.settings?.visibleTaskProviders)
  const defaultTaskSource = useAppStore((s) => s.settings?.defaultTaskSource ?? 'github')
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const preflightStatusContextKey = useAppStore((s) => s.preflightStatusContextKey)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const expectedPreflightContextKey = useAppStore((s) =>
    localPreflightContextKey(getLocalPreflightContext(s))
  )
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const prefetchWorkItems = useAppStore((s) => s.prefetchWorkItems)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const defaultTaskViewPreset = useAppStore((s) => s.settings?.defaultTaskViewPreset ?? 'all')
  const preferredVisibleTaskProviders = React.useMemo(
    () => normalizeVisibleTaskProviders(rawVisibleTaskProviders),
    [rawVisibleTaskProviders]
  )
  const preflightStatusCurrent = preflightStatusContextKey === expectedPreflightContextKey
  const visibleTaskProviders = React.useMemo(
    () =>
      restoreAvailableDefaultTaskProvider(
        preferredVisibleTaskProviders,
        {
          gitlabInstalled: preflightStatusCurrent && preflightStatus?.glab?.installed === true,
          linearConnected: linearStatus.connected === true
        },
        defaultTaskSource
      ),
    [
      defaultTaskSource,
      linearStatus.connected,
      preferredVisibleTaskProviders,
      preflightStatusCurrent,
      preflightStatus?.glab?.installed
    ]
  )
  const resolvedDefaultTaskSource = React.useMemo(
    () => resolveVisibleTaskProvider(defaultTaskSource, visibleTaskProviders),
    [defaultTaskSource, visibleTaskProviders]
  )

  React.useEffect(() => {
    if (!preflightStatusChecked || !preflightStatusCurrent) {
      void refreshPreflightStatus()
    }
    if (!linearStatusChecked) {
      void checkLinearConnection()
    }
  }, [
    checkLinearConnection,
    linearStatusChecked,
    preflightStatusChecked,
    preflightStatusCurrent,
    refreshPreflightStatus
  ])

  const handlePrefetch = React.useCallback(() => {
    if (resolvedDefaultTaskSource !== 'github') {
      return
    }
    const activeRepo = activeRepoId ? (repoMap.get(activeRepoId) ?? null) : null
    const activeGitRepo = activeRepo && isGitRepoKind(activeRepo) ? activeRepo : null
    const firstGitRepo = activeGitRepo ?? repos.find((r) => isGitRepoKind(r))
    if (firstGitRepo?.path) {
      prefetchWorkItems(
        firstGitRepo.id,
        firstGitRepo.path,
        PER_REPO_FETCH_LIMIT,
        getTaskPresetQuery(defaultTaskViewPreset)
      )
    }
  }, [
    activeRepoId,
    defaultTaskViewPreset,
    prefetchWorkItems,
    repoMap,
    repos,
    resolvedDefaultTaskSource
  ])

  const hideTasksButton = React.useCallback(() => {
    void updateSettings({ showTasksButton: false })
  }, [updateSettings])

  if (!showTasksButton) {
    return null
  }

  const tasksActive = activeView === 'tasks'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* Why: shortcuts sit beside the Tasks button, not inside it, so each stays keyboard-reachable. */}
        <div className="group relative">
          <button
            type="button"
            onClick={() => openTaskPage()}
            onPointerEnter={handlePrefetch}
            onFocus={handlePrefetch}
            aria-current={tasksActive ? 'page' : undefined}
            data-contextual-tour-target="sidebar-tasks"
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
              tasksActive
                ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
                : 'text-worktree-sidebar-foreground/60 group-hover:bg-worktree-sidebar-foreground/8'
            )}
          >
            <List
              className={cn(
                'size-4 shrink-0',
                !tasksActive && 'text-worktree-sidebar-foreground/30'
              )}
              strokeWidth={tasksActive ? 2.25 : 1.75}
            />
            <span className="flex-1">
              {translate('auto.components.sidebar.SidebarNav.fee535205b', 'Tasks')}
            </span>
          </button>
          <span className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 can-hover:pointer-events-none can-hover:opacity-0 can-hover:group-hover:pointer-events-auto can-hover:group-hover:opacity-100 can-hover:group-focus-within:pointer-events-auto can-hover:group-focus-within:opacity-100">
            {visibleTaskProviders.includes('github') ? (
              <TaskProviderShortcut
                label={translate(
                  'auto.components.sidebar.SidebarNav.0ccba862b8',
                  'Open GitHub tasks'
                )}
                onOpen={() => openTaskPage({ taskSource: 'github' })}
              >
                <Github className="size-3.5" aria-hidden />
              </TaskProviderShortcut>
            ) : null}
            {visibleTaskProviders.includes('gitlab') ? (
              <TaskProviderShortcut
                label={translate(
                  'auto.components.sidebar.SidebarNav.196c1b5362',
                  'Open GitLab tasks'
                )}
                onOpen={() => openTaskPage({ taskSource: 'gitlab' })}
              >
                <Gitlab className="size-3.5" aria-hidden />
              </TaskProviderShortcut>
            ) : null}
            {visibleTaskProviders.includes('linear') ? (
              <TaskProviderShortcut
                label={translate(
                  'auto.components.sidebar.SidebarNav.c39ab10000',
                  'Open Linear tasks'
                )}
                onOpen={() => openTaskPage({ taskSource: 'linear' })}
              >
                <LinearIcon className="size-3.5" />
              </TaskProviderShortcut>
            ) : null}
            {visibleTaskProviders.includes('jira') ? (
              <TaskProviderShortcut
                label={translate(
                  'auto.components.sidebar.SidebarNav.e7ad3c540d',
                  'Open Jira tasks'
                )}
                onOpen={() => openTaskPage({ taskSource: 'jira' })}
              >
                <JiraIcon className="size-3.5" />
              </TaskProviderShortcut>
            ) : null}
          </span>
        </div>
      </ContextMenuTrigger>
      <HideTaskSidebarMenu onHide={hideTasksButton} />
    </ContextMenu>
  )
}
