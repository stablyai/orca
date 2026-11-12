import React, { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { cn } from '@/lib/class-names'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../../shared/execution-host'
import { isRepoHidden } from '../../../../../shared/hidden-projects'
import { getRepoHostIdentityForParts } from '../../../../../shared/repo-host-identity'
import type { Repo } from '../../../../../shared/repo-types'
import { setProjectHidden } from './set-project-hidden'

function selectHiddenRepos(repos: readonly Repo[]): Repo[] {
  return repos
    .filter(isRepoHidden)
    .sort(
      (a, b) => (b.hiddenAt ?? 0) - (a.hiddenAt ?? 0) || a.displayName.localeCompare(b.displayName)
    )
}

/** Collapsed list of hidden projects under the workspace list, each with a Show action. */
const HiddenProjectsSection = React.memo(function HiddenProjectsSection() {
  const t = useTranslate()
  // Own language subscription: this memo boundary would otherwise keep the boot language.
  useTranslation()
  const listId = useId()
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
    await setProjectHidden([repo], false, repo.displayName)
    setPendingKeys((previous) => {
      const next = new Set(previous)
      next.delete(key)
      return next
    })
  }

  return (
    <section
      data-testid="hidden-projects"
      className="max-h-[40%] shrink-0 overflow-y-auto border-t border-worktree-sidebar-border px-2 py-1 scrollbar-sleek"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((value) => !value)}
        className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-[11px] leading-none text-muted-foreground transition-colors hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-worktree-sidebar-ring"
      >
        <ChevronRight
          className={cn('size-3 shrink-0 transition-transform', expanded && 'rotate-90')}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">
          {t('sidebar.hiddenProjects.sectionTitle', 'Hidden projects ({{count}})', {
            count: hiddenRepos.length
          })}
        </span>
      </button>
      <ul
        id={listId}
        hidden={!expanded}
        className="flex flex-col pb-1"
        aria-label={t('sidebar.hiddenProjects.listLabel', 'Hidden projects')}
      >
        {hiddenRepos.map((repo, index) => {
          const key = getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo))
          const hostLabel = hostLabels?.[index]
          return (
            <li
              key={key}
              data-testid="hidden-project"
              className="group/hidden-project flex h-7 min-w-0 items-center gap-1.5 rounded-md pl-1.5 pr-0.5 transition-colors hover:bg-worktree-sidebar-accent focus-within:bg-worktree-sidebar-accent"
            >
              <RepoIconGlyph
                repoIcon={repo.repoIcon}
                color={repo.badgeColor || undefined}
                className="size-4 shrink-0 text-muted-foreground"
                iconClassName="size-3.5"
              />
              <span className="min-w-0 flex-1 truncate text-[13px] leading-4">
                {repo.displayName}
              </span>
              {hostLabel ? (
                <span className="min-w-0 max-w-[40%] shrink truncate text-[10px] leading-none text-muted-foreground">
                  {hostLabel}
                </span>
              ) : null}
              {/* Revealed on row hover; focus-within keeps it visible for keyboard users. */}
              <span className="flex shrink-0 can-hover:opacity-0 can-hover:group-hover/hidden-project:opacity-100 focus-within:opacity-100">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={pendingKeys.has(key)}
                  aria-label={t(
                    'sidebar.hiddenProjects.showAriaLabel',
                    'Show {{name}} in the sidebar',
                    { name: repo.displayName }
                  )}
                  onClick={() => void show(repo, key)}
                  className="shrink-0"
                >
                  {t('sidebar.hiddenProjects.show', 'Show')}
                </Button>
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
})

export default HiddenProjectsSection
