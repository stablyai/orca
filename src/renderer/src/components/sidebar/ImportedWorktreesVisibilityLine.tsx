import React, { useState } from 'react'
import { ChevronRight, EyeOff, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getExternalWorktreeParentPath } from '../../../../shared/external-worktree-visibility'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { translate } from '@/i18n/i18n'

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
  onShow?: () => void
  onKeepHidden?: () => void
  className?: string
}

const PREVIEW_LIMIT = 3
const KEEP_HIDDEN_LABEL = 'Keep hidden - recover from the project menu'
const GROUP_LIMIT = 5

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
  return getExternalWorktreeParentPath(path)
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
  const [expandedGroupPathKeys, setExpandedGroupPathKeys] = useState<Set<string>>(new Set())
  const hiddenCount = hiddenWorktrees.length
  const worktreeNoun = pluralizeWorktree(hiddenCount)
  const worktreeGroups = groupWorktreesByParentPath(hiddenWorktrees)
  const visibleWorktreeGroups = worktreeGroups.slice(0, GROUP_LIMIT)
  const remainingGroupCount = Math.max(0, worktreeGroups.length - visibleWorktreeGroups.length)
  const keepHiddenAriaLabel = `Keep ${hiddenCount} discovered ${worktreeNoun} hidden for ${repoDisplayName}; recover from the project menu`

  if (hiddenCount === 0) {
    return null
  }

  const lineText =
    placement === 'pinned-fallback'
      ? `Hiding ${hiddenCount} discovered ${worktreeNoun} in ${repoDisplayName}`
      : `Hiding ${hiddenCount} discovered ${worktreeNoun}`

  const toggleGroupExpanded = (path: string): void => {
    const key = normalizeRuntimePathForComparison(path)
    setExpandedGroupPathKeys((previous) => {
      const next = new Set(previous)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  return (
    <section
      aria-busy={pending}
      className={cn('mx-1 my-0.5 ml-3 text-worktree-sidebar-foreground', className)}
    >
      <div
        className={cn(
          'flex min-h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] leading-none text-muted-foreground transition-colors',
          'hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground'
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={pending}
          aria-expanded={isExpanded}
          aria-label={translate(
            'auto.components.sidebar.ImportedWorktreesVisibilityLine.f54f2bec5d',
            '{{value0}} hidden worktrees for {{value1}}',
            { value0: isExpanded ? 'Collapse' : 'Expand', value1: repoDisplayName }
          )}
          onClick={() => setIsExpanded((value) => !value)}
          className="shrink-0 rounded-[4px] text-muted-foreground hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground"
        >
          <ChevronRight
            className={cn('size-3 transition-transform', isExpanded && 'rotate-90')}
            aria-hidden="true"
          />
        </Button>
        <EyeOff className="size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{lineText}</span>
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
                className="shrink-0 rounded-md text-muted-foreground hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground"
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
        <div
          className="ml-4 mt-0.5 grid gap-1 border-l border-worktree-sidebar-border pb-1 pl-2"
          aria-label={translate(
            'auto.components.sidebar.ImportedWorktreesVisibilityLine.2251d41ebb',
            'Hidden worktree groups'
          )}
        >
          {visibleWorktreeGroups.map((group) => (
            <div key={group.path} className="grid min-w-0 gap-0.5 rounded-md px-1.5 py-1">
              <div className="flex min-h-7 min-w-0 items-center gap-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      tabIndex={0}
                      className="block min-w-0 flex-1 truncate font-mono text-[10px] leading-4 text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring"
                    >
                      {group.path}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    {group.path}
                  </TooltipContent>
                </Tooltip>
                <span className="shrink-0 rounded-full border border-worktree-sidebar-border px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                  {group.worktrees.length}
                </span>
              </div>
              <ul
                className="list-disc space-y-0.5 py-0 pl-5 pr-2 text-xs text-muted-foreground marker:text-muted-foreground"
                aria-label={translate(
                  'auto.components.sidebar.ImportedWorktreesVisibilityLine.b47ba1a9d2',
                  '{{value0}} preview',
                  { value0: group.path }
                )}
              >
                {group.worktrees
                  .slice(
                    0,
                    expandedGroupPathKeys.has(normalizeRuntimePathForComparison(group.path))
                      ? group.worktrees.length
                      : PREVIEW_LIMIT
                  )
                  .map((worktree, index) => (
                    <li
                      key={getWorktreeKey(worktree, index, 'preview')}
                      className="min-h-6 min-w-0 py-0.5 pl-0"
                    >
                      <span className="block min-w-0 truncate font-medium">
                        {worktree.displayName}
                      </span>
                    </li>
                  ))}
                {group.worktrees.length > PREVIEW_LIMIT ? (
                  <li className="list-none">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={pending}
                      onClick={() => toggleGroupExpanded(group.path)}
                      className="h-6 justify-start px-0 text-[11px] font-normal text-muted-foreground hover:text-worktree-sidebar-accent-foreground"
                    >
                      {expandedGroupPathKeys.has(normalizeRuntimePathForComparison(group.path))
                        ? translate(
                            'auto.components.sidebar.ImportedWorktreesVisibilityLine.294de4aeb2',
                            'Show fewer'
                          )
                        : translate(
                            'auto.components.sidebar.ImportedWorktreesVisibilityLine.5a9688802a',
                            'Show {{value0}} more',
                            { value0: group.worktrees.length - PREVIEW_LIMIT }
                          )}
                    </Button>
                  </li>
                ) : null}
              </ul>
            </div>
          ))}
          {remainingGroupCount > 0 ? (
            <div className="py-1 pl-7 pr-2 text-[11px] leading-4 text-muted-foreground">
              + {remainingGroupCount}{' '}
              {translate(
                'auto.components.sidebar.ImportedWorktreesVisibilityLine.b2bc47c080',
                'more locations'
              )}
            </div>
          ) : null}
          <div className="grid gap-1 px-1.5 pb-1 pt-1">
            <p className="rounded-md bg-worktree-sidebar-accent px-2 py-1 text-[10px] font-medium leading-4 text-worktree-sidebar-accent-foreground">
              {translate(
                'auto.components.sidebar.ImportedWorktreesVisibilityLine.9f4f14e821',
                'Change this later from the project menu.'
              )}
            </p>
            <div className="flex min-w-0 items-center gap-1.5">
              {onKeepHidden ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={pending}
                  onClick={onKeepHidden}
                  className="h-6 px-2 text-[11px] font-medium"
                >
                  {translate(
                    'auto.components.sidebar.ImportedWorktreesVisibilityLine.ad99f4eea9',
                    'Keep hidden'
                  )}
                </Button>
              ) : null}
              {onShow ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={pending}
                  onClick={onShow}
                  className="h-6 px-2 text-[11px] font-medium"
                >
                  {translate(
                    'auto.components.sidebar.ImportedWorktreesVisibilityLine.b7a87dc32f',
                    'Show in worktree list'
                  )}
                </Button>
              ) : null}
            </div>
          </div>
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
