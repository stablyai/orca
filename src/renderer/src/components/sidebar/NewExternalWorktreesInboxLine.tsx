import React, { useState } from 'react'
import { ChevronRight, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { NewExternalWorktreeInboxPreview } from './new-external-worktrees-inbox-candidates'

type NewExternalWorktreesInboxLineProps = {
  repoDisplayName: string
  inboxWorktrees: readonly NewExternalWorktreeInboxPreview[]
  pending: boolean
  error: string | null
  onImportWorktree?: (worktreeId: string) => void
  onKeepHidden?: () => void
  onManageVisibility?: () => void
  onImportAll?: () => void
  onSuppress?: () => void
  className?: string
}

const INBOX_PREVIEW_LIMIT = 3

// Why: interpolated so locales control where the link sits in the sentence;
// U+0000 cannot appear in translated copy, so the split is unambiguous.
const HERE_TOKEN = '\u0000'

export default function NewExternalWorktreesInboxLine({
  repoDisplayName,
  inboxWorktrees,
  pending,
  error,
  onImportWorktree,
  onKeepHidden,
  onManageVisibility,
  onImportAll,
  onSuppress,
  className
}: NewExternalWorktreesInboxLineProps): React.JSX.Element | null {
  const [isExpanded, setIsExpanded] = useState(false)
  const [showAllRows, setShowAllRows] = useState(false)
  const inboxCount = inboxWorktrees.length
  const visibleInboxWorktrees = showAllRows
    ? inboxWorktrees
    : inboxWorktrees.slice(0, INBOX_PREVIEW_LIMIT)
  const hiddenInboxCount = inboxCount - visibleInboxWorktrees.length
  const suppressLabel = translate(
    'auto.components.sidebar.NewExternalWorktreesInboxLine.c3e8a1f4b2',
    "Don't show again"
  )
  const suppressAriaLabel = translate(
    'auto.components.sidebar.NewExternalWorktreesInboxLine.9f2d4c8b17',
    'Hide external worktrees permanently for {{value0}}',
    { value0: repoDisplayName }
  )

  const recoveryLinkLabel = translate(
    'auto.components.sidebar.NewExternalWorktreesInboxLine.9df3261ba4',
    'here'
  )
  const [recoveryBeforeLink, recoveryAfterLink] = translate(
    'auto.components.sidebar.NewExternalWorktreesInboxLine.7bd104ea28',
    'You can always change this later from {{value0}}',
    { value0: HERE_TOKEN }
  ).split(HERE_TOKEN)

  if (inboxCount === 0) {
    return null
  }

  return (
    <section
      aria-busy={pending}
      className={cn('mx-1 my-0.5 ml-3 text-worktree-sidebar-foreground', className)}
    >
      <div
        className={cn(
          'group flex min-h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] leading-none text-muted-foreground transition-colors',
          'hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground'
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={pending}
          aria-expanded={isExpanded}
          aria-label={
            isExpanded
              ? translate(
                  'auto.components.sidebar.NewExternalWorktreesInboxLine.d9f7b2a14c',
                  'Collapse new externally-created worktrees for {{value0}}',
                  { value0: repoDisplayName }
                )
              : translate(
                  'auto.components.sidebar.NewExternalWorktreesInboxLine.e2c4a8d91f',
                  'Expand new externally-created worktrees for {{value0}}',
                  { value0: repoDisplayName }
                )
          }
          onClick={() => setIsExpanded((value) => !value)}
          className="shrink-0 rounded-[4px] text-muted-foreground hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground"
        >
          <ChevronRight
            className={cn('size-3 transition-transform', isExpanded && 'rotate-90')}
            aria-hidden="true"
          />
        </Button>
        <span className="min-w-0 flex-1 truncate">
          {translate(
            'auto.components.sidebar.NewExternalWorktreesInboxLine.7c4e9b2a81',
            'New externally-created worktrees'
          )}
        </span>
        <span className="relative inline-grid size-6 shrink-0 place-items-center">
          <span
            className={cn(
              'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-border px-1.5 text-[10px] font-medium leading-none text-muted-foreground transition-opacity',
              onSuppress &&
                'can-hover:group-hover:opacity-0 can-hover:group-focus-within:opacity-0 [@media(hover:none)]:opacity-0'
            )}
          >
            {inboxCount}
          </span>
          {onSuppress ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={pending}
                  aria-label={suppressAriaLabel}
                  onClick={onSuppress}
                  className="absolute inset-0 text-muted-foreground hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground can-hover:pointer-events-none can-hover:opacity-0 can-hover:group-hover:pointer-events-auto can-hover:group-hover:opacity-100 can-hover:group-focus-within:pointer-events-auto can-hover:group-focus-within:opacity-100"
                >
                  <X className="size-3" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {suppressLabel}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </span>
      </div>

      {isExpanded ? (
        <div className="ml-4 mt-0.5 border-l border-worktree-sidebar-border pb-1 pl-2">
          <p className="px-1.5 py-1 text-[10px] leading-4 text-muted-foreground">
            {translate(
              'auto.components.sidebar.NewExternalWorktreesInboxLine.4d7a1c9e53',
              'These worktrees were created outside of Orca.'
            )}
          </p>
          <ul className="grid gap-0.5">
            {visibleInboxWorktrees.map((worktree) => (
              <li
                key={worktree.id ?? worktree.path ?? worktree.displayName}
                className="flex min-h-7 min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-worktree-sidebar-accent"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{worktree.displayName}</div>
                  {worktree.displayPath ? (
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {worktree.displayPath}
                    </div>
                  ) : null}
                </div>
                {onImportWorktree && worktree.id ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={pending}
                    aria-label={translate(
                      'auto.components.sidebar.NewExternalWorktreesInboxLine.2f8a5c1d90',
                      'Show {{value0}} in the sidebar',
                      { value0: worktree.displayName }
                    )}
                    onClick={() => onImportWorktree(worktree.id!)}
                  >
                    {translate(
                      'auto.components.sidebar.NewExternalWorktreesInboxLine.3a9b6d2e01',
                      'Show'
                    )}
                  </Button>
                ) : null}
              </li>
            ))}
            {hiddenInboxCount > 0 ? (
              <li>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={pending}
                  onClick={() => setShowAllRows((value) => !value)}
                  className="h-6 justify-start px-1.5 text-[11px] font-normal text-muted-foreground hover:text-worktree-sidebar-accent-foreground"
                >
                  {translate(
                    'auto.components.sidebar.NewExternalWorktreesInboxLine.4bac7e3f12',
                    'Show {{value0}} more',
                    { value0: hiddenInboxCount }
                  )}
                </Button>
              </li>
            ) : showAllRows && inboxCount > INBOX_PREVIEW_LIMIT ? (
              <li>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={pending}
                  onClick={() => setShowAllRows(false)}
                  className="h-6 justify-start px-1.5 text-[11px] font-normal text-muted-foreground hover:text-worktree-sidebar-accent-foreground"
                >
                  {translate(
                    'auto.components.sidebar.NewExternalWorktreesInboxLine.5cbd8f4023',
                    'Show fewer'
                  )}
                </Button>
              </li>
            ) : null}
          </ul>
          <div className="grid gap-1 px-1.5 pb-1 pt-1">
            <p className="rounded-md bg-worktree-sidebar-accent px-2 py-1 text-[10px] font-medium leading-4 text-worktree-sidebar-accent-foreground">
              {recoveryBeforeLink}
              {onManageVisibility ? (
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  disabled={pending}
                  onClick={onManageVisibility}
                  className="h-auto whitespace-normal p-0 text-left text-[10px] font-medium leading-4 text-worktree-sidebar-accent-foreground underline underline-offset-2"
                >
                  {recoveryLinkLabel}
                </Button>
              ) : (
                <span className="underline underline-offset-2">{recoveryLinkLabel}</span>
              )}
              {recoveryAfterLink}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {onKeepHidden ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={pending}
                  onClick={onKeepHidden}
                >
                  {translate(
                    'auto.components.sidebar.NewExternalWorktreesInboxLine.1c9e7a4b28',
                    'Keep hidden'
                  )}
                </Button>
              ) : null}
              {onImportAll ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={pending}
                  onClick={onImportAll}
                >
                  {translate(
                    'auto.components.sidebar.NewExternalWorktreesInboxLine.7edfa16245',
                    'Show all'
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
