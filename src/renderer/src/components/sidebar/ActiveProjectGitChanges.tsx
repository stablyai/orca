import React, { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { GitStatusEntry } from '../../../../shared/types'

export type ProjectGitChangeCounts = {
  modified: number
  deleted: number
  added: number
}

const CHANGE_PRESENTATION = [
  {
    key: 'modified',
    className: 'text-[var(--git-decoration-modified)]'
  },
  {
    key: 'deleted',
    className: 'text-[var(--git-decoration-deleted)]'
  },
  {
    key: 'added',
    className: 'text-[var(--git-decoration-added)]'
  }
] as const

export function countProjectGitChanges(entries: readonly GitStatusEntry[]): ProjectGitChangeCounts {
  const counts: ProjectGitChangeCounts = { modified: 0, deleted: 0, added: 0 }

  for (const entry of entries) {
    if (entry.status === 'deleted') {
      counts.deleted += 1
    } else if (entry.status === 'added' || entry.status === 'untracked') {
      counts.added += 1
    } else {
      // Why: the compact project summary has three requested buckets; renamed
      // and copied files remain edited content rather than disappearing.
      counts.modified += 1
    }
  }

  return counts
}

export function ProjectGitChanges({
  entries
}: {
  entries: readonly GitStatusEntry[] | undefined
}): React.JSX.Element | null {
  const counts = useMemo(() => countProjectGitChanges(entries ?? []), [entries])

  if (counts.modified === 0 && counts.deleted === 0 && counts.added === 0) {
    return null
  }

  return (
    <span
      data-active-project-git-changes=""
      className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] font-semibold leading-none"
    >
      {CHANGE_PRESENTATION.map(({ key, className }) =>
        counts[key] > 0 ? (
          <span
            key={key}
            data-git-change-kind={key}
            className={className}
            aria-label={`${key} ${counts[key]}`}
          >
            !{counts[key]}
          </span>
        ) : null
      )}
    </span>
  )
}

export function ActiveProjectGitChanges({
  worktreeId
}: {
  worktreeId: string | null
}): React.JSX.Element | null {
  const entries = useAppStore((state) =>
    worktreeId ? state.gitStatusByWorktree[worktreeId] : undefined
  )

  return <ProjectGitChanges entries={entries} />
}
