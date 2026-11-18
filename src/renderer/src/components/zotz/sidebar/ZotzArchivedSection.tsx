import React, { useEffect, useMemo, useState } from 'react'
import { ArchiveRestore, ChevronDown, ChevronRight } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { isRepoHidden } from '../../../../../shared/hidden-projects'
import { onZotzShowArchived, setZotzConversationArchived } from './zotz-archive'

/** Archived conversations at the foot of the sidebar, folded until asked for. */
export function ZotzArchivedSection(): React.JSX.Element | null {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  useEffect(() => onZotzShowArchived(() => setOpen(true)), [])

  const archived = useMemo(
    () =>
      repos
        .filter((repo) => !isRepoHidden(repo))
        .flatMap((repo) =>
          (worktreesByRepo[repo.id] ?? [])
            .filter((worktree) => worktree.isArchived && !worktree.isMainWorktree)
            .map((worktree) => ({ worktree, repo }))
        )
        .sort((a, b) => b.worktree.lastActivityAt - a.worktree.lastActivityAt),
    [repos, worktreesByRepo]
  )
  if (archived.length === 0) {
    return null
  }
  return (
    <section className="shrink-0 border-t border-worktree-sidebar-border px-2 py-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-worktree-sidebar-foreground/60 outline-none hover:bg-worktree-sidebar-foreground/5 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {t('zotz.sidebar.archivedTitle', 'Archived')}
        <span className="text-worktree-sidebar-foreground/40">{archived.length}</span>
      </button>
      {open ? (
        <ul className="scrollbar-sleek mt-1 max-h-56 space-y-0.5 overflow-y-auto">
          {archived.map(({ worktree, repo }) => (
            <li
              key={worktree.id}
              className="flex min-w-0 items-center gap-2 rounded-md py-1 pr-1 pl-6 text-worktree-sidebar-foreground/70"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs">{worktree.displayName}</span>
                <span className="block truncate text-2xs text-worktree-sidebar-foreground/45">
                  {repo.displayName}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('zotz.sidebar.restore', 'Restore {{name}}', {
                  name: worktree.displayName
                })}
                onClick={() => setZotzConversationArchived(worktree, false)}
              >
                <ArchiveRestore className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
