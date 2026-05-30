import React, { useMemo, useState } from 'react'
import { ChevronDown, Ellipsis } from 'lucide-react'

import { Button } from '@/components/ui/button'
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

function getDetailText(worktree: ImportedWorktreeVisibilityPreview): string {
  const parts = [worktree.displayName]
  if (worktree.path) {
    parts.push(worktree.path)
  }
  if (worktree.branch) {
    parts.push(worktree.branch)
  }
  return parts.join(' · ')
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
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = React.useId()
  const hiddenCount = hiddenWorktrees.length
  const worktreeNoun = pluralizeWorktree(hiddenCount)
  const previewWorktrees = useMemo(() => hiddenWorktrees.slice(0, PREVIEW_LIMIT), [hiddenWorktrees])
  const hasExtraRows = hiddenWorktrees.length > PREVIEW_LIMIT
  const hasPathDetails = hiddenWorktrees.some((worktree) => worktree.path || worktree.branch)
  const hasDetails = hasExtraRows || hasPathDetails

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
        placement === 'repo-group' ? 'ml-7' : 'ml-5',
        className
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-semibold leading-5">{title}</h3>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{subtitle}</p>
        </div>

        {hasDetails ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-controls={detailsId}
            aria-expanded={detailsOpen}
            aria-label={
              detailsOpen ? 'Hide imported worktree details' : 'Show imported worktree details'
            }
            disabled={pending}
            onClick={() => setDetailsOpen((open) => !open)}
            className="mt-0.5 shrink-0 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <ChevronDown
              className={cn('size-3 transition-transform', detailsOpen ? 'rotate-180' : '')}
            />
          </Button>
        ) : null}
      </div>

      <div className="mt-2 grid gap-1" aria-label="Imported worktree preview">
        {previewWorktrees.map((worktree, index) => (
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

      {hasDetails ? (
        <div className="mt-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-controls={detailsId}
            aria-expanded={detailsOpen}
            disabled={pending}
            onClick={() => setDetailsOpen((open) => !open)}
            className="h-6 px-2 text-[11px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            {detailsOpen ? 'Hide details' : 'Show details'}
            <ChevronDown
              className={cn('size-3 transition-transform', detailsOpen ? 'rotate-180' : '')}
            />
          </Button>

          <div
            id={detailsId}
            hidden={!detailsOpen}
            className="mt-2 grid gap-1 border-t border-sidebar-border pt-2"
          >
            {hiddenWorktrees.map((worktree, index) => (
              <div
                key={getWorktreeKey(worktree, index, 'detail')}
                className="min-w-0 truncate text-[11px] leading-4 text-muted-foreground"
                title={getDetailText(worktree)}
              >
                {getDetailText(worktree)}
              </div>
            ))}
          </div>
        </div>
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
