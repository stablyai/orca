import React, { useState } from 'react'
import { Ellipsis } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { dirname } from '@/lib/path'
import { cn } from '@/lib/utils'

export type ImportedWorktreesVisibilityPlacement = 'repo-group' | 'pinned-fallback'

export type ImportedWorktreeVisibilityPreview = {
  id?: string
  displayName: string
  path?: string
  branch?: string
}

type ImportedWorktreesVisibilityCardProps = {
  repoDisplayName: string
  hiddenWorktrees: readonly ImportedWorktreeVisibilityPreview[]
  placement: ImportedWorktreesVisibilityPlacement
  pending: boolean
  error: string | null
  onShow: () => void
  onKeepHidden?: () => void
  className?: string
}

const PREVIEW_LIMIT = 3
const UNKNOWN_LOCATION_LABEL = 'Unknown location'

type ImportedWorktreePathGroup = {
  path: string
  worktrees: ImportedWorktreeVisibilityPreview[]
}

function pluralizeWorktree(count: number): string {
  return count === 1 ? 'worktree' : 'worktrees'
}

function getWorktreeKey(
  worktree: ImportedWorktreeVisibilityPreview,
  index: number,
  prefix: string
): string {
  return worktree.id ?? worktree.path ?? `${prefix}-${worktree.displayName}-${index}`
}

function getParentPath(path: string | undefined): string {
  if (!path) {
    return UNKNOWN_LOCATION_LABEL
  }
  const parentPath = dirname(path)
  if (!parentPath || parentPath === '.') {
    return UNKNOWN_LOCATION_LABEL
  }
  return parentPath
}

function groupWorktreesByParentPath(
  worktrees: readonly ImportedWorktreeVisibilityPreview[]
): ImportedWorktreePathGroup[] {
  const groups: ImportedWorktreePathGroup[] = []
  const groupByPath = new Map<string, ImportedWorktreePathGroup>()
  for (const worktree of worktrees) {
    const path = getParentPath(worktree.path)
    const existing = groupByPath.get(path)
    if (existing) {
      existing.worktrees.push(worktree)
      continue
    }
    const group = { path, worktrees: [worktree] }
    groupByPath.set(path, group)
    groups.push(group)
  }
  return groups
}

export default function ImportedWorktreesVisibilityCard({
  repoDisplayName,
  hiddenWorktrees,
  placement,
  pending,
  error,
  onShow,
  onKeepHidden,
  className
}: ImportedWorktreesVisibilityCardProps): React.JSX.Element | null {
  const [isExpanded, setIsExpanded] = useState(false)
  const hiddenCount = hiddenWorktrees.length
  const worktreeNoun = pluralizeWorktree(hiddenCount)
  const visibleWorktrees = isExpanded ? hiddenWorktrees : hiddenWorktrees.slice(0, PREVIEW_LIMIT)
  const visibleWorktreeGroups = groupWorktreesByParentPath(visibleWorktrees)
  const remainingCount = Math.max(0, hiddenWorktrees.length - visibleWorktrees.length)

  if (hiddenCount === 0) {
    return null
  }

  const title =
    placement === 'pinned-fallback'
      ? `Imported ${hiddenCount} existing ${worktreeNoun} in ${repoDisplayName}`
      : `Imported ${hiddenCount} existing ${worktreeNoun}`
  const subtitle =
    placement === 'pinned-fallback'
      ? `Orca found ${hiddenCount} ${worktreeNoun} and imported them automatically into ${repoDisplayName}.`
      : `Orca found ${hiddenCount} ${worktreeNoun} and imported them automatically into this repo.`

  return (
    <section
      aria-busy={pending}
      className={cn(
        'mx-1 my-1.5 rounded-lg border border-sidebar-border bg-sidebar-accent/60 p-2.5 text-sidebar-foreground',
        placement === 'repo-group' ? 'ml-9' : 'ml-7',
        className
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-semibold leading-5">{title}</h3>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{subtitle}</p>
        </div>
      </div>

      <div className="mt-2 grid gap-1.5" aria-label="Imported worktree preview">
        {visibleWorktreeGroups.map((group) => (
          <div key={group.path} className="grid min-w-0 gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className="block w-full min-w-0 truncate px-1 font-mono text-[10px] leading-4 text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
                >
                  {group.path}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {group.path}
              </TooltipContent>
            </Tooltip>
            {group.worktrees.map((worktree, index) => (
              <div
                key={getWorktreeKey(worktree, index, 'preview')}
                className="flex min-h-6 min-w-0 items-center justify-between gap-2 rounded-md bg-sidebar px-2 text-xs"
              >
                <span className="min-w-0 truncate font-medium text-sidebar-foreground">
                  {worktree.displayName}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">hidden</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {remainingCount > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={pending}
          onClick={() => setIsExpanded(true)}
          className="mt-1.5 h-6 px-2 text-[11px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          Show {remainingCount} more
        </Button>
      ) : null}

      {placement === 'repo-group' ? (
        <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
          They are currently hidden, but you can show or hide them anytime by clicking{' '}
          <span className="inline-flex size-5 align-middle items-center justify-center rounded-md border border-sidebar-border bg-sidebar-accent text-muted-foreground">
            <Ellipsis className="size-3" aria-hidden="true" />
            <span className="sr-only">repo options</span>
          </span>{' '}
          on this repo.
        </p>
      ) : (
        <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
          They are currently hidden in this view. Showing them restores the imported worktrees to
          the repo list.
        </p>
      )}

      {error ? (
        <p className="mt-2 text-[11px] leading-4 text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-sidebar-border pt-2">
        {onKeepHidden ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={pending}
            aria-label={`Keep ${hiddenCount} imported ${worktreeNoun} hidden for ${repoDisplayName}`}
            onClick={onKeepHidden}
            className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            Keep hidden
          </Button>
        ) : (
          <span className="min-w-0 text-[11px] leading-4 text-muted-foreground">
            Use Show to restore this repo&apos;s imported worktrees.
          </span>
        )}
        <Button
          type="button"
          size="xs"
          disabled={pending}
          aria-label={`Show ${hiddenCount} imported ${worktreeNoun} for ${repoDisplayName}`}
          onClick={onShow}
        >
          Show
        </Button>
      </div>
    </section>
  )
}

export type { ImportedWorktreesVisibilityCardProps }
