import React from 'react'
import { Github, ListChecks } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getTaskPresetQuery } from '@/lib/new-workspace'

function LinearIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  )
}

const SidebarNav = React.memo(function SidebarNav() {
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  const activeView = useAppStore((s) => s.activeView)
  const repos = useAppStore((s) => s.repos)
  const canBrowseTasks = repos.some((repo) => isGitRepoKind(repo))

  // Why: warm the GitHub work-item cache on hover/focus so by the time the
  // user's click finishes the round-trip has either completed or is already
  // in-flight. Shaves ~200–600ms off perceived page-load latency.
  const prefetchWorkItems = useAppStore((s) => s.prefetchWorkItems)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const defaultTaskViewPreset = useAppStore((s) => s.settings?.defaultTaskViewPreset ?? 'all')
  const handlePrefetch = React.useCallback(() => {
    if (!canBrowseTasks) {
      return
    }
    const activeRepo = repos.find((r) => r.id === activeRepoId && isGitRepoKind(r))
    const firstGitRepo = activeRepo ?? repos.find((r) => isGitRepoKind(r))
    if (firstGitRepo?.path) {
      // Why: warm the exact cache key the page will read on mount — must
      // match TaskPage's `initialTaskQuery` derived from the same default
      // preset, otherwise the prefetch lands in a key the page never reads
      // and we pay the full round-trip after click.
      prefetchWorkItems(firstGitRepo.path, 36, getTaskPresetQuery(defaultTaskViewPreset))
    }
  }, [activeRepoId, canBrowseTasks, defaultTaskViewPreset, prefetchWorkItems, repos])

  const tasksActive = activeView === 'tasks'

  return (
    <div className="flex flex-col gap-0.5 px-2 pt-2 pb-1">
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
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
          tasksActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
          !canBrowseTasks && 'cursor-not-allowed opacity-50 hover:bg-transparent'
        )}
      >
        <ListChecks className="size-4 shrink-0" />
        <span className="flex-1">Tasks</span>
        <span className="flex items-center gap-1 text-muted-foreground/70">
          <Github className="size-3.5" aria-hidden />
          <LinearIcon className="size-3.5" />
        </span>
      </button>
    </div>
  )
})

export default SidebarNav
