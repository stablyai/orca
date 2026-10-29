import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { FileTypeIcon } from '../FileTypeIcon'
import { VirtualizedList } from '../virtualized-list'
import { Badge } from '../ui/badge'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { STATUS_COLORS, STATUS_LABELS } from '../right-sidebar/status-display'
import { DiffLineCounts } from '../right-sidebar/source-control/listing/diff-line-counts'
import { openWorkspaceSpaceChange } from './workspace-space-open-change'
import { translate } from '@/i18n/i18n'

export function WorkspaceSpaceChanges({
  worktree,
  entries,
  canOpen
}: {
  worktree: WorkspaceSpaceWorktree
  entries: readonly GitStatusEntry[]
  canOpen: boolean
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const normalizedQuery = query.trim().toLowerCase()
  const rows = useMemo(
    () => entries.filter((entry) => entry.path.toLowerCase().includes(normalizedQuery)),
    [entries, normalizedQuery]
  )
  const fileCount = useMemo(() => new Set(entries.map((entry) => entry.path)).size, [entries])
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge variant="outline" asChild>
          <button
            type="button"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {translate('workspaceSpace.changes.count', 'Changed files ({{count}})', {
              count: fileCount
            })}
            <ChevronRight />
          </button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(32rem,calc(100vw-2rem))]"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="space-y-2 border-b border-border p-3">
          <div className="truncate text-sm font-semibold">{worktree.displayName}</div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'workspaceSpace.changes.description',
              'Uncommitted files · Click a file to view its changes in Orca.'
            )}
          </p>
          <Input
            aria-label={translate('workspaceSpace.changes.search', 'Filter changed files')}
            placeholder={translate('workspaceSpace.changes.search', 'Filter changed files')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div ref={setScrollElement} className="max-h-72 overflow-y-auto scrollbar-sleek">
          <VirtualizedList
            rows={rows}
            scrollElement={scrollElement}
            estimateRowHeightPx={36}
            getRowKey={(entry) => `${entry.area}:${entry.path}`}
            announceListPosition
            renderRow={(entry) => (
              <button
                key={`${entry.area}:${entry.path}`}
                type="button"
                disabled={!canOpen}
                onClick={() => openWorkspaceSpaceChange(worktree, entry)}
                className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
              >
                <FileTypeIcon
                  filePath={entry.path}
                  className="size-3.5 shrink-0"
                  style={{ color: STATUS_COLORS[entry.status] }}
                />
                <span
                  className="min-w-0 flex-1 truncate"
                  title={entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
                >
                  {entry.path}
                </span>
                <DiffLineCounts added={entry.added} removed={entry.removed} />
                <span className="shrink-0 text-muted-foreground">
                  {entry.conflictStatus === 'unresolved'
                    ? translate('workspaceSpace.changes.conflict', 'Conflict')
                    : entry.area === 'staged'
                      ? translate('workspaceSpace.changes.staged', 'Staged')
                      : entry.area === 'untracked'
                        ? translate('workspaceSpace.changes.untracked', 'Untracked')
                        : translate('workspaceSpace.changes.unstaged', 'Unstaged')}
                </span>
                <span style={{ color: STATUS_COLORS[entry.status] }}>
                  {STATUS_LABELS[entry.status]}
                </span>
              </button>
            )}
          />
          {rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {translate('workspaceSpace.changes.empty', 'No matching files.')}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
