import React from 'react'
import { Bell, CalendarClock, EyeOff, Github, Gitlab, List, Search, Smartphone } from 'lucide-react'
import { useAppStore } from '@/store'
import { useRepoMap } from '@/store/selectors'
import { cn } from '@/lib/utils'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { GlobalSettings } from '../../../../shared/types'
import { getTaskPresetQuery, PER_REPO_FETCH_LIMIT } from '@/lib/new-workspace'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { JiraIcon } from '@/components/icons/JiraIcon'
import {
  normalizeVisibleTaskProviders,
  restoreAvailableDefaultTaskProvider,
  resolveVisibleTaskProvider
} from '../../../../shared/task-providers'
import { useActivityUnreadCount } from '@/components/activity/useActivityUnreadCount'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { useMobileSidebarOnboardingBadge } from './mobile-sidebar-onboarding-badge'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { SetupGuideSidebarEntry } from './SetupGuideSidebarEntry'
import { translate } from '@/i18n/i18n'

export { getSetupGuideSidebarEntryReady, shouldShowSetupGuideEntry } from './SetupGuideSidebarEntry'

export function shouldShowAgentsButton(
  settings: Pick<GlobalSettings, 'experimentalActivity'> | null | undefined
): boolean {
  return settings?.experimentalActivity === true
}

export function shouldShowMobileButton(
  settings: Pick<GlobalSettings, 'showMobileButton'> | null | undefined
): boolean {
  return settings?.showMobileButton !== false
}

export function shouldShowAutomationsButton(
  settings: Pick<GlobalSettings, 'showAutomationsButton'> | null | undefined
): boolean {
  return settings?.showAutomationsButton !== false
}

function HideSidebarMenu({ onHide }: { onHide: () => void }): React.JSX.Element {
  return (
    <ContextMenuContent>
      <ContextMenuItem onSelect={onHide}>
        <EyeOff className="size-3.5" />
        {translate("auto.components.sidebar.SidebarNav.d599269755", "Hide from sidebar")}</ContextMenuItem>
    </ContextMenuContent>
  )
}

function TaskProviderShortcut({
  canBrowseTasks,
  label,
  onOpen,
  children
}: {
  canBrowseTasks: boolean
  label: string
  onOpen: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      role={canBrowseTasks ? 'button' : undefined}
      tabIndex={-1}
      onClick={(e) => {
        e.stopPropagation()
        if (!canBrowseTasks) {
          return
        }
        onOpen()
      }}
      className={cn(
        'rounded p-0.5 text-muted-foreground/70',
        canBrowseTasks ? 'transition-colors hover:text-foreground' : 'cursor-default'
      )}
      aria-label={canBrowseTasks ? label : undefined}
      aria-hidden={canBrowseTasks ? undefined : true}
    >
      {children}
    </span>
  )
}

const SidebarNav = React.memo(function SidebarNav() {
  const worktreePaletteShortcut = useShortcutLabel('worktree.palette')
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  const openAutomationsPage = useAppStore((s) => s.openAutomationsPage)
  const openActivityPage = useAppStore((s) => s.openActivityPage)
  const openMobilePage = useAppStore((s) => s.openMobilePage)
  const openModal = useAppStore((s) => s.openModal)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const activeView = useAppStore((s) => s.activeView)
  const repos = useAppStore((s) => s.repos)
  const repoMap = useRepoMap()
  const canBrowseTasks = repos.some((repo) => isGitRepoKind(repo))
  // Why: the setting is opt-out (default true). `!== false` keeps the button
  // visible for users whose persisted settings predate this field.
  const showTasksButton = useAppStore((s) => s.settings?.showTasksButton !== false)
  const rawVisibleTaskProviders = useAppStore((s) => s.settings?.visibleTaskProviders)
  const defaultTaskSource = useAppStore((s) => s.settings?.defaultTaskSource ?? 'github')
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const showAgentsButton = useAppStore((s) => shouldShowAgentsButton(s.settings))
  const showAutomationsButton = useAppStore((s) => shouldShowAutomationsButton(s.settings))
  const showMobileButton = useAppStore((s) => shouldShowMobileButton(s.settings))
  const preferredVisibleTaskProviders = React.useMemo(
    () => normalizeVisibleTaskProviders(rawVisibleTaskProviders),
    [rawVisibleTaskProviders]
  )
  const visibleTaskProviders = React.useMemo(
    () =>
      restoreAvailableDefaultTaskProvider(
        preferredVisibleTaskProviders,
        {
          gitlabInstalled: preflightStatus?.glab?.installed === true,
          linearConnected: linearStatus.connected === true
        },
        defaultTaskSource
      ),
    [
      defaultTaskSource,
      linearStatus.connected,
      preferredVisibleTaskProviders,
      preflightStatus?.glab?.installed
    ]
  )
  const resolvedDefaultTaskSource = React.useMemo(
    () => resolveVisibleTaskProvider(defaultTaskSource, visibleTaskProviders),
    [defaultTaskSource, visibleTaskProviders]
  )

  React.useEffect(() => {
    if (!preflightStatusChecked) {
      void refreshPreflightStatus()
    }
    if (!linearStatusChecked) {
      void checkLinearConnection()
    }
  }, [checkLinearConnection, linearStatusChecked, preflightStatusChecked, refreshPreflightStatus])

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
  const mobileActive = activeView === 'mobile'
  const activityUnreadCount = useActivityUnreadCount(showAgentsButton, 'sidebar-badge')
  const mobileOnboardingBadge = useMobileSidebarOnboardingBadge(showMobileButton)
  const hideTasksButton = React.useCallback(() => {
    void updateSettings({ showTasksButton: false })
  }, [updateSettings])
  const hideAutomationsButton = React.useCallback(() => {
    void updateSettings({ showAutomationsButton: false })
  }, [updateSettings])
  const hideMobileButton = React.useCallback(() => {
    void updateSettings({ showMobileButton: false })
  }, [updateSettings])

  return (
    <div
      className="flex flex-col gap-0.5 px-2 pt-2 pb-1"
      data-contextual-tour-target="sidebar-navigation"
    >
      <SetupGuideSidebarEntry />
      {showTasksButton ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>
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
              aria-disabled={!canBrowseTasks}
              aria-current={tasksActive ? 'page' : undefined}
              data-contextual-tour-target="sidebar-tasks"
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
                tasksActive
                  ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
                  : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8',
                !canBrowseTasks && 'cursor-not-allowed opacity-50 hover:bg-transparent'
              )}
            >
              <List
                className={cn(
                  'size-4 shrink-0',
                  !tasksActive && 'text-worktree-sidebar-foreground/30'
                )}
                strokeWidth={tasksActive ? 2.25 : 1.75}
              />
              <span className="flex-1">{translate("auto.components.sidebar.SidebarNav.fee535205b", "Tasks")}</span>
              <span className="flex items-center gap-1">
                {visibleTaskProviders.includes('github') ? (
                  <TaskProviderShortcut
                    canBrowseTasks={canBrowseTasks}
                    label={translate("auto.components.sidebar.SidebarNav.0ccba862b8", "Open GitHub tasks")}
                    onOpen={() => {
                      openTaskPage({ taskSource: 'github' })
                    }}
                  >
                    <Github className="size-3.5" aria-hidden />
                  </TaskProviderShortcut>
                ) : null}
                {visibleTaskProviders.includes('gitlab') ? (
                  <TaskProviderShortcut
                    canBrowseTasks={canBrowseTasks}
                    label={translate("auto.components.sidebar.SidebarNav.196c1b5362", "Open GitLab tasks")}
                    onOpen={() => {
                      openTaskPage({ taskSource: 'gitlab' })
                    }}
                  >
                    <Gitlab className="size-3.5" aria-hidden />
                  </TaskProviderShortcut>
                ) : null}
                {visibleTaskProviders.includes('linear') ? (
                  <TaskProviderShortcut
                    canBrowseTasks={canBrowseTasks}
                    label={translate("auto.components.sidebar.SidebarNav.c39ab10000", "Open Linear tasks")}
                    onOpen={() => {
                      openTaskPage({ taskSource: 'linear' })
                    }}
                  >
                    <LinearIcon className="size-3.5" />
                  </TaskProviderShortcut>
                ) : null}
                {visibleTaskProviders.includes('jira') ? (
                  <TaskProviderShortcut
                    canBrowseTasks={canBrowseTasks}
                    label={translate("auto.components.sidebar.SidebarNav.e7ad3c540d", "Open Jira tasks")}
                    onOpen={() => {
                      openTaskPage({ taskSource: 'jira' })
                    }}
                  >
                    <JiraIcon className="size-3.5" />
                  </TaskProviderShortcut>
                ) : null}
              </span>
            </button>
          </ContextMenuTrigger>
          <HideSidebarMenu onHide={hideTasksButton} />
        </ContextMenu>
      ) : null}
      {showAutomationsButton ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              onClick={openAutomationsPage}
              aria-current={automationsActive ? 'page' : undefined}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
                automationsActive
                  ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
                  : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
              )}
            >
              <CalendarClock
                className={cn(
                  'size-4 shrink-0',
                  !automationsActive && 'text-worktree-sidebar-foreground/30'
                )}
                strokeWidth={automationsActive ? 2.25 : 1.75}
              />
              <span className="flex-1">{translate("auto.components.sidebar.SidebarNav.f323383e9a", "Automations")}</span>
            </button>
          </ContextMenuTrigger>
          <HideSidebarMenu onHide={hideAutomationsButton} />
        </ContextMenu>
      ) : null}
      {showAgentsButton ? (
        <button
          type="button"
          onClick={openActivityPage}
          aria-current={activityActive ? 'page' : undefined}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
            activityActive
              ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
              : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
          )}
        >
          <Bell
            className={cn(
              'size-4 shrink-0',
              !activityActive && 'text-worktree-sidebar-foreground/30'
            )}
            strokeWidth={activityActive ? 2.25 : 1.75}
          />
          <span className="flex-1">{translate("auto.components.sidebar.SidebarNav.9c95e1ce91", "Agents")}</span>
          {activityUnreadCount > 0 ? (
            <span className="rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground">
              {activityUnreadCount}
            </span>
          ) : null}
        </button>
      ) : null}
      {showMobileButton ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              onClick={() => {
                mobileOnboardingBadge.dismiss()
                openMobilePage()
              }}
              aria-current={mobileActive ? 'page' : undefined}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
                mobileActive
                  ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
                  : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
              )}
            >
              <Smartphone
                className={cn(
                  'size-4 shrink-0',
                  !mobileActive && 'text-worktree-sidebar-foreground/30'
                )}
                strokeWidth={mobileActive ? 2.25 : 1.75}
              />
              <span className="flex-1">{translate("auto.components.sidebar.SidebarNav.1b5c41caee", "Orca Mobile")}</span>
              {mobileOnboardingBadge.visible ? (
                <span className="rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground">
                  {translate("auto.components.sidebar.SidebarNav.c86d83b5c3", "New")}</span>
              ) : null}
            </button>
          </ContextMenuTrigger>
          <HideSidebarMenu onHide={hideMobileButton} />
        </ContextMenu>
      ) : null}
      <button
        type="button"
        onClick={() => openModal('worktree-palette')}
        aria-label={translate("auto.components.sidebar.SidebarNav.0c3395fd32", "Search worktrees and browser tabs")}
        className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight text-worktree-sidebar-foreground/60 transition-colors hover:bg-worktree-sidebar-foreground/8"
      >
        <Search
          className="size-4 shrink-0 text-worktree-sidebar-foreground/30"
          strokeWidth={1.75}
        />
        <span className="flex-1">{translate("auto.components.sidebar.SidebarNav.80611a8b10", "Search")}</span>
        <kbd className="hidden rounded border border-border/60 bg-background/40 px-1.5 py-px font-mono text-[10px] font-medium text-muted-foreground group-hover:inline-flex items-center">
          {worktreePaletteShortcut}
        </kbd>
      </button>
    </div>
  )
})

export default SidebarNav
