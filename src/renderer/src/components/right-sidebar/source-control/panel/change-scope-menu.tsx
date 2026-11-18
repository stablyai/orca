import React, { useMemo, useState } from 'react'
import { ChevronsUpDown, GitGraph } from 'lucide-react'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { GitHistoryItem } from '../../../../../../shared/git/history/git-history-types'
import type { GitHistoryPanelState } from '../sync/use-git-history'
import { formatGitHistoryAge } from '../sync/git-history-format'
import { formatSourceControlRefLabel } from './branch-context-stats'
import {
  ALL_CHANGES_SCOPE,
  changeScopeKey,
  commitScopeFromPage,
  shortCommitId,
  type SourceControlChangeScope
} from './change-scope'

const COMMIT_FILTER_THRESHOLD = 10
const MENU_ITEM_SELECTOR = '[role="menuitemradio"], [role="menuitem"]'

export function commitMetaLine(item: GitHistoryItem, intlLocale: string): string {
  return [shortCommitId(item), item.author, formatGitHistoryAge(item.timestamp, intlLocale)]
    .filter(Boolean)
    .join(' · ')
}

function ScopeItemText({ title, detail }: { title: string; detail?: string }): React.JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate">{title}</span>
      {detail ? <span className="truncate text-2xs text-muted-foreground">{detail}</span> : null}
    </span>
  )
}

export function SourceControlChangeScopeMenuContent({
  scope,
  onScopeChange,
  baseRef,
  onChangeBaseRef,
  allDetail,
  uncommittedDetail,
  historyState,
  graphSupported,
  onOpenGitGraph,
  onRetry
}: {
  scope: SourceControlChangeScope
  onScopeChange: (scope: SourceControlChangeScope) => void
  baseRef: string | null
  onChangeBaseRef: () => void
  allDetail: string
  uncommittedDetail: string
  historyState: GitHistoryPanelState
  graphSupported: boolean
  onOpenGitGraph: () => void
  onRetry: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const [query, setQuery] = useState('')
  const result = historyState.result
  const commits = useMemo(() => result?.items ?? [], [result])
  const normalizedQuery = query.trim().toLowerCase()
  const visibleCommits = useMemo(
    () =>
      normalizedQuery
        ? commits.filter(
            (item) =>
              item.subject.toLowerCase().includes(normalizedQuery) ||
              item.id.startsWith(normalizedQuery) ||
              (item.author ?? '').toLowerCase().includes(normalizedQuery)
          )
        : commits,
    [commits, normalizedQuery]
  )
  const commitsById = useMemo(() => new Map(commits.map((item) => [item.id, item])), [commits])
  // Plain HEAD pages (no base, older host, branch is its own base) read as Recent commits.
  const commitsLabel = result?.branch
    ? t('auto.components.right.sidebar.SourceControl.scopeBranchCommits', 'Commits on this branch')
    : t('auto.components.right.sidebar.SourceControl.scopeRecentCommits', 'Recent commits')

  return (
    <DropdownMenuContent
      align="start"
      density="compact"
      className="w-[min(340px,calc(100vw-16px))]"
      data-testid="source-control-change-scope-menu"
      onOpenAutoFocus={(event) => {
        // Start on the checked scope, like a native select.
        const content = event.currentTarget
        const checked =
          content instanceof HTMLElement
            ? content.querySelector<HTMLElement>('[aria-checked="true"]')
            : null
        if (checked) {
          event.preventDefault()
          checked.focus()
        }
      }}
    >
      {baseRef ? (
        <>
          <DropdownMenuItem onSelect={onChangeBaseRef}>
            <span className="min-w-0 flex-1 truncate">
              {t(
                'auto.components.right.sidebar.SourceControl.scopeCompareTo',
                'Compare to {{ref}}',
                {
                  ref: formatSourceControlRefLabel(baseRef)
                }
              )}
            </span>
            <ChevronsUpDown className="size-3 text-muted-foreground" />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      ) : null}
      <DropdownMenuRadioGroup
        value={changeScopeKey(scope)}
        onValueChange={(value) => {
          if (value === 'all') {
            onScopeChange(ALL_CHANGES_SCOPE)
          } else if (value === 'uncommitted') {
            onScopeChange({ kind: 'uncommitted' })
          } else {
            const commit = commitsById.get(value.slice('commit:'.length))
            if (commit && result) {
              onScopeChange(commitScopeFromPage(commit, result))
            }
          }
        }}
      >
        <DropdownMenuRadioItem value="all" className="items-start">
          <ScopeItemText
            title={t('auto.components.right.sidebar.SourceControl.scopeAllChanges', 'All changes')}
            detail={allDetail}
          />
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="uncommitted" className="items-start">
          <ScopeItemText
            title={t('auto.components.right.sidebar.SourceControl.scopeUncommitted', 'Uncommitted')}
            detail={uncommittedDetail}
          />
        </DropdownMenuRadioItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{commitsLabel}</DropdownMenuLabel>
        {commits.length > COMMIT_FILTER_THRESHOLD ? (
          <div className="px-1.5 pb-1">
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  const menu = event.currentTarget.closest('[role="menu"]')
                  const items = [...(menu?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR) ?? [])]
                  const below = items.find(
                    (item) =>
                      event.currentTarget.compareDocumentPosition(item) &
                      Node.DOCUMENT_POSITION_FOLLOWING
                  )
                  below?.focus()
                  return
                }
                // Keep menu typeahead from moving focus off the field while typing.
                if (event.key !== 'Escape' && event.key !== 'Tab') {
                  event.stopPropagation()
                }
              }}
              placeholder={t(
                'auto.components.right.sidebar.SourceControl.scopeFilterCommits',
                'Filter commits'
              )}
              aria-label={t(
                'auto.components.right.sidebar.SourceControl.scopeFilterCommits',
                'Filter commits'
              )}
              className="h-6 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring"
            />
          </div>
        ) : null}
        {visibleCommits.map((item) => (
          <DropdownMenuRadioItem key={item.id} value={`commit:${item.id}`} className="items-start">
            <ScopeItemText title={item.subject} detail={commitMetaLine(item, intlLocale)} />
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {historyState.status === 'error' && !result ? (
        <div className="flex items-center gap-2 px-2.5 py-1 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate" title={historyState.error}>
            {t(
              'auto.components.right.sidebar.SourceControl.scopeCommitsFailed',
              "Couldn't load commits."
            )}
          </span>
          <DropdownMenuItem
            className="shrink-0"
            onSelect={(event) => {
              // Retry in place; closing the menu would hide the result it fetches.
              event.preventDefault()
              onRetry()
            }}
          >
            {t('auto.components.right.sidebar.SourceControl.scopeRetryCommits', 'Retry')}
          </DropdownMenuItem>
        </div>
      ) : visibleCommits.length === 0 ? (
        <div className="px-2.5 py-1 text-xs text-muted-foreground">
          {!result
            ? t(
                'auto.components.right.sidebar.SourceControl.scopeLoadingCommits',
                'Loading commits…'
              )
            : normalizedQuery
              ? t(
                  'auto.components.right.sidebar.SourceControl.scopeNoMatchingCommits',
                  'No matching commits'
                )
              : result.branch
                ? t(
                    'auto.components.right.sidebar.SourceControl.scopeNoBranchCommitsYet',
                    'No commits on this branch yet'
                  )
                : t(
                    'auto.components.right.sidebar.SourceControl.scopeNoCommitsYet',
                    'No commits yet'
                  )}
        </div>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={!graphSupported} onSelect={onOpenGitGraph}>
        <GitGraph className="size-3.5 text-muted-foreground" />
        {t(
          'auto.components.right.sidebar.SourceControl.scopeOlderHistory',
          'Older history in Git Graph'
        )}
      </DropdownMenuItem>
    </DropdownMenuContent>
  )
}
