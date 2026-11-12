import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../../shared/execution-host'
import { isRepoHidden } from '../../../../../shared/hidden-projects'
import { getRepoHostIdentityForParts } from '../../../../../shared/repo-host-identity'
import type { Repo } from '../../../../../shared/repo-types'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { setProjectHidden } from './set-project-hidden'

function selectHiddenRepos(repos: readonly Repo[]): Repo[] {
  return repos
    .filter(isRepoHidden)
    .sort(
      (a, b) => (b.hiddenAt ?? 0) - (a.hiddenAt ?? 0) || a.displayName.localeCompare(b.displayName)
    )
}

/** Collapsed list of hidden projects under the workspace list, each with a Show button. */
const HiddenProjectsSection = React.memo(function HiddenProjectsSection() {
  const t = useTranslate()
  // Own language subscription: this memo boundary would otherwise keep the boot language.
  useTranslation()
  const hiddenRepos = useAppStore(useShallow((state) => selectHiddenRepos(state.repos)))
  const [expanded, setExpanded] = useState(false)
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set())
  // Name hosts only when one is not this computer; a local-only list needs no host column.
  const hostLabels = useAppStore(
    useShallow((state) =>
      hiddenRepos.some((repo) => getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID)
        ? hiddenRepos.map((repo) =>
            selectExecutionHostDisplayLabel(state, getRepoExecutionHostId(repo))
          )
        : null
    )
  )
  if (hiddenRepos.length === 0) {
    return null
  }

  const show = async (repo: Repo, key: string): Promise<void> => {
    setPendingKeys((previous) => new Set(previous).add(key))
    await setProjectHidden(repo, false)
    setPendingKeys((previous) => {
      const next = new Set(previous)
      next.delete(key)
      return next
    })
  }

  const lineText = t('sidebar.hiddenProjects.count', '{{count}} hidden projects', {
    count: hiddenRepos.length,
    defaultValue_one: '{{count}} hidden project'
  })

  return (
    <section
      data-testid="hidden-projects"
      className="max-h-[40%] shrink-0 overflow-y-auto border-t border-worktree-sidebar-border px-2 py-1 scrollbar-sleek"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-[11px] leading-none text-muted-foreground transition-colors hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-worktree-sidebar-ring"
      >
        <ChevronRight
          className={cn('size-3 shrink-0 transition-transform', expanded && 'rotate-90')}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">{lineText}</span>
      </button>
      {expanded ? (
        <ul
          className="ml-3 mt-0.5 flex flex-col border-l border-worktree-sidebar-border pb-1 pl-2"
          aria-label={t('sidebar.hiddenProjects.listLabel', 'Hidden projects')}
        >
          {hiddenRepos.map((repo, index) => {
            const hostId = getRepoExecutionHostId(repo)
            const key = getRepoHostIdentityForParts(repo.id, hostId)
            const hostLabel = hostLabels?.[index]
            return (
              <li
                key={key}
                data-testid="hidden-project"
                className="flex h-7 min-w-0 items-center gap-1.5 px-1"
              >
                <span className="min-w-0 flex-1 truncate text-[13px]">{repo.displayName}</span>
                {hostLabel ? (
                  <span className="min-w-0 max-w-[40%] shrink truncate text-[10px] leading-none text-muted-foreground">
                    {hostLabel}
                  </span>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={pendingKeys.has(key)}
                  aria-label={t(
                    'sidebar.hiddenProjects.showAriaLabel',
                    'Show {{name}} in the sidebar',
                    {
                      name: repo.displayName
                    }
                  )}
                  onClick={() => void show(repo, key)}
                  className="shrink-0"
                >
                  {t('sidebar.hiddenProjects.show', 'Show')}
                </Button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
})

export default HiddenProjectsSection
