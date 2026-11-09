import React from 'react'
import { GitBranch, GitCommitHorizontal } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import {
  CHANGE_LETTER,
  changeKind,
  formatRelative,
  parseDiffStat,
  type ChangeKind
} from '@/lib/orca-cloud/orca-cloud-workspace-state'

export type CloudGitChangesData = {
  branch: string | null
  upstream?: string | null
  ahead?: number | null
  behind?: number | null
  /** A `--shortstat` line, if captured. */
  diffStat?: string | null
  changes: readonly { status: string; path: string }[]
  /** Total uncommitted changes when `changes` was capped. */
  changeCount?: number
  commits: readonly { sha: string; subject: string; at: number | null }[]
}

const KIND_TONE: Record<ChangeKind, string> = {
  // The theme's git decoration colors: tuned for contrast in light and dark.
  modified: 'text-[var(--git-decoration-modified)]',
  added: 'text-[var(--git-decoration-added)]',
  untracked: 'text-[var(--git-decoration-untracked)]',
  deleted: 'text-[var(--git-decoration-deleted)]',
  renamed: 'text-[var(--git-decoration-renamed)]',
  copied: 'text-[var(--git-decoration-copied)]',
  unknown: 'text-muted-foreground'
}

function kindLabel(kind: ChangeKind, t: Translate): string {
  switch (kind) {
    case 'modified':
      return t('orcaCloudWorkspace.change.modified', 'Modified')
    case 'added':
      return t('orcaCloudWorkspace.change.added', 'Added')
    case 'deleted':
      return t('orcaCloudWorkspace.change.deleted', 'Deleted')
    case 'renamed':
      return t('orcaCloudWorkspace.change.renamed', 'Renamed')
    case 'copied':
      return t('orcaCloudWorkspace.change.copied', 'Copied')
    case 'untracked':
      return t('orcaCloudWorkspace.change.untracked', 'Untracked')
    case 'unknown':
      return t('orcaCloudWorkspace.change.unknown', 'Changed')
  }
}

const MAX_CHANGES = 50
const MAX_COMMITS = 8

/**
 * Branch, uncommitted changes and recent commits, read-only. Shared by the asleep view (client
 * cache) and the archived view (captured at archive), so both read the same.
 */
export function CloudGitChanges({
  data,
  now
}: {
  data: CloudGitChangesData
  now: number
}): React.JSX.Element {
  const t = useTranslate()
  const stat = parseDiffStat(data.diffStat)
  const totalChanges = Math.max(data.changeCount ?? 0, data.changes.length)
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
      data-cloud-git-changes=""
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <GitBranch className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="font-medium text-foreground">
          {data.branch ?? t('orcaCloudWorkspace.archived.detached', 'Detached HEAD')}
        </span>
        {data.ahead ? (
          <span className="tabular-nums text-muted-foreground">
            {t('orcaCloudWorkspace.archived.ahead', '{{count}} ahead', { count: data.ahead })}
          </span>
        ) : null}
        {data.behind ? (
          <span className="tabular-nums text-muted-foreground">
            {t('orcaCloudWorkspace.archived.behind', '{{count}} behind', { count: data.behind })}
          </span>
        ) : null}
        {stat ? (
          <span className="tabular-nums text-muted-foreground">
            {t('orcaCloudWorkspace.archived.files', '{{count}} files', { count: stat.files })}{' '}
            <span className="text-[var(--git-decoration-added)]">+{stat.insertions}</span>{' '}
            <span className="text-[var(--git-decoration-deleted)]">−{stat.deletions}</span>
          </span>
        ) : null}
      </div>
      {data.changes.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">
            {t('orcaCloudWorkspace.archived.uncommitted', 'Uncommitted changes')}
          </span>
          <ul className="flex flex-col font-mono text-[11px]">
            {data.changes.slice(0, MAX_CHANGES).map((change) => {
              const kind = changeKind(change.status)
              return (
                <li key={`${change.status}:${change.path}`} className="flex gap-2">
                  <span className={cn('w-3 shrink-0', KIND_TONE[kind])} aria-hidden="true">
                    {CHANGE_LETTER[kind]}
                  </span>
                  <span className="sr-only">{kindLabel(kind, t)}:</span>
                  <span className="truncate text-foreground">{change.path}</span>
                </li>
              )
            })}
          </ul>
          {totalChanges > MAX_CHANGES ? (
            <span className="text-[11px] text-muted-foreground">
              {t('orcaCloudWorkspace.archived.moreChanges', '{{count}} more', {
                count: totalChanges - MAX_CHANGES
              })}
            </span>
          ) : null}
        </div>
      ) : null}
      {data.commits.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {data.commits.slice(0, MAX_COMMITS).map((commit) => (
            <li key={commit.sha} className="flex items-start gap-2 text-xs">
              <GitCommitHorizontal
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-foreground">{commit.subject}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {commit.sha.slice(0, 7)}
              </span>
              {commit.at ? (
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {formatRelative(commit.at, now)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t('orcaCloudWorkspace.archived.noCommits', 'No commits on this branch yet.')}
        </p>
      )}
    </div>
  )
}
