import React, { useState } from 'react'
import { ChevronRight, EyeOff, X } from 'lucide-react'

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

type ImportedWorktreesVisibilityLineProps = {
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
const KEEP_HIDDEN_LABEL = 'Keep hidden - recover from the repo menu'

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

export function groupWorktreesByParentPath(
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

export default function ImportedWorktreesVisibilityLine({
  repoDisplayName,
  hiddenWorktrees,
  placement,
  pending,
  error,
  onShow,
  onKeepHidden,
  className
}: ImportedWorktreesVisibilityLineProps): React.JSX.Element | null {
  const [isExpanded, setIsExpanded] = useState(false)
  const hiddenCount = hiddenWorktrees.length
  const worktreeNoun = pluralizeWorktree(hiddenCount)
  const visibleWorktrees = hiddenWorktrees.slice(0, PREVIEW_LIMIT)
  const visibleWorktreeGroups = groupWorktreesByParentPath(visibleWorktrees)
  const remainingCount = Math.max(0, hiddenWorktrees.length - visibleWorktrees.length)
  const keepHiddenAriaLabel = `Keep ${hiddenCount} discovered ${worktreeNoun} hidden for ${repoDisplayName}; recover from the repo menu`

  if (hiddenCount === 0) {
    return null
  }

  const lineText =
    placement === 'pinned-fallback'
      ? `Hiding ${hiddenCount} discovered ${worktreeNoun} in ${repoDisplayName}`
      : `Hiding ${hiddenCount} discovered ${worktreeNoun}`

  return (
    <section
      aria-busy={pending}
      className={cn('mx-1 my-0.5 ml-5 text-sidebar-foreground', className)}
    >
      <div
        className={cn(
          'flex min-h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] leading-none text-muted-foreground transition-colors',
          'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={pending}
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} hidden worktrees for ${repoDisplayName}`}
          onClick={() => setIsExpanded((value) => !value)}
          className="shrink-0 rounded-[4px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <ChevronRight
            className={cn('size-3 transition-transform', isExpanded && 'rotate-90')}
            aria-hidden="true"
          />
        </Button>
        <EyeOff className="size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{lineText}</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={pending}
          aria-label={`Show all ${hiddenCount} discovered ${worktreeNoun} for ${repoDisplayName}`}
          onClick={onShow}
          className="h-6 shrink-0 px-1.5 text-[11px] font-medium text-sidebar-primary hover:bg-sidebar-accent hover:text-sidebar-primary"
        >
          Show all
        </Button>
        {onKeepHidden ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={pending}
                aria-label={keepHiddenAriaLabel}
                onClick={onKeepHidden}
                className="shrink-0 rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              >
                <X className="size-3" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {KEEP_HIDDEN_LABEL}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      {isExpanded ? (
        <div className="mt-0.5 grid gap-0.5 pb-1" aria-label="Hidden worktree preview">
          {visibleWorktreeGroups.map((group) => (
            <div key={group.path} className="grid min-w-0 gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    className="block min-w-0 truncate py-1 pl-7 pr-2 font-mono text-[10px] leading-4 text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
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
                  className="flex min-h-7 min-w-0 items-center gap-2 rounded-md py-0 pl-5 pr-2 text-xs text-muted-foreground hover:bg-sidebar-accent"
                >
                  <span
                    className="size-2 shrink-0 rounded-full border border-dashed border-muted-foreground/50"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate font-medium">{worktree.displayName}</span>
                </div>
              ))}
            </div>
          ))}
          {remainingCount > 0 ? (
            <div className="py-1 pl-7 pr-2 text-[11px] leading-4 text-muted-foreground">
              + {remainingCount} more
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="px-1.5 pb-1 pt-0.5 text-[11px] leading-4 text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}

export type { ImportedWorktreesVisibilityLineProps }
