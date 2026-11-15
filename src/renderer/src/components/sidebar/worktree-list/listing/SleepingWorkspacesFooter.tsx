import React, { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { activateWorktreeFromSidebar } from '@/lib/workspace/activation/sidebar-worktree-activation'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { useHiddenSleepingWorktrees } from './use-hidden-sleeping-worktrees'

type SleepingWorkspacesFooterProps = {
  worktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
  showProjectNames: boolean
}

const ROW_CLASS =
  'flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-1.5 text-left text-[11px] leading-none text-muted-foreground transition-colors hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

export function SleepingWorkspacesFooter({
  worktrees,
  repoMap,
  showProjectNames
}: SleepingWorkspacesFooterProps): React.JSX.Element | null {
  const t = useTranslate()
  const [isExpanded, setIsExpanded] = useState(false)
  if (worktrees.length === 0) {
    return null
  }
  return (
    // Why stop keydown: the enclosing listbox treats arrows and Enter as row navigation.
    <section className="mx-1 mb-2 mt-1 pr-1" onKeyDown={(event) => event.stopPropagation()}>
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded((value) => !value)}
        className={cn(ROW_CLASS, 'pl-1.5')}
      >
        <ChevronRight
          className={cn('size-3 shrink-0 transition-transform', isExpanded && 'rotate-90')}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">
          {t('auto.components.sidebar.SleepingWorkspacesFooter.sleeping', 'Sleeping')}
        </span>
        <span className="shrink-0 tabular-nums">{worktrees.length}</span>
      </button>
      {isExpanded ? (
        <ul className="mt-0.5">
          {worktrees.map((worktree) => (
            <li key={getWorktreeHostIdentity(worktree)}>
              <button
                type="button"
                onClick={() => void activateWorktreeFromSidebar(worktree.id, worktree.hostId)}
                className={cn(ROW_CLASS, 'pl-6')}
              >
                <span className="min-w-0 truncate">{worktree.displayName}</span>
                {showProjectNames ? (
                  <span className="ml-auto min-w-0 shrink truncate text-[10px] opacity-70">
                    {repoMap.get(worktree.repoId)?.displayName}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

/** Memoized so the virtualized viewport keeps its props identity across list renders. */
export function useSleepingWorkspacesFooter(
  visibleWorktrees: readonly Worktree[],
  repoMap: Map<string, Repo>,
  repoCount: number
): React.ReactNode {
  const worktrees = useHiddenSleepingWorktrees(visibleWorktrees)
  return useMemo(
    () => (
      <SleepingWorkspacesFooter
        worktrees={worktrees}
        repoMap={repoMap}
        showProjectNames={repoCount > 1}
      />
    ),
    [worktrees, repoMap, repoCount]
  )
}
