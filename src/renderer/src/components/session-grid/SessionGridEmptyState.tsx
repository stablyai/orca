import React, { useState } from 'react'
import { Eye, LayoutGrid, Plus, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import type { SessionGridFilter } from '../../../../shared/session-grid-types'
import { SessionGridLaunchPopoverContent } from './SessionGridLaunchPicker'
import type { SessionGridEmptyStateReason } from './session-grid-empty-state'
import type { SessionGridWorktreeCatalog } from './session-grid-worktree-catalog'

function EmptyStateFrame({
  reason,
  title,
  body,
  children
}: {
  reason: SessionGridEmptyStateReason
  title: string
  body: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid="session-grid-empty-state"
      data-reason={reason}
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center select-none"
    >
      <div className="flex size-12 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
        <LayoutGrid className="size-7" />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground">{body}</p>
      </div>
      {children}
    </div>
  )
}

/**
 * What an empty grid says, and what it offers to do about it.
 *
 * The three cases are not decorations: only one of them is "there is nothing to see", and the
 * other two already have their sessions open. Offering to create another there answered a
 * question the user had not asked and left the real one — a lit chip, a "Hidden N" pill —
 * unanswered on the same screen.
 */
export function SessionGridEmptyState({
  reason,
  canLaunchFirst,
  activeFilter,
  defaultWorktreeId,
  worktreeCatalog,
  gridWorktreeIds,
  onRevealHidden,
  onClearFilters
}: {
  reason: SessionGridEmptyStateReason
  canLaunchFirst: boolean
  activeFilter: SessionGridFilter
  defaultWorktreeId?: string
  worktreeCatalog: SessionGridWorktreeCatalog
  gridWorktreeIds: readonly string[]
  onRevealHidden: () => void
  /** Clears every lens the page owns, not just the two the store holds. */
  onClearFilters: () => void
}): React.JSX.Element {
  const [launchOpen, setLaunchOpen] = useState(false)
  if (reason === 'hidden') {
    return (
      <EmptyStateFrame
        reason={reason}
        title={translate(
          'auto.components.session.grid.SessionsGridPage.emptyHiddenTitle',
          'Every session here is hidden'
        )}
        body={translate(
          'auto.components.session.grid.SessionsGridPage.emptyHiddenBody',
          'You took these cards out of the grid. Their sessions are still running.'
        )}
      >
        <Button
          size="sm"
          variant="outline"
          data-testid="session-grid-empty-reveal-hidden"
          onClick={onRevealHidden}
          className="mt-2 gap-1.5 text-xs"
        >
          <Eye className="size-3.5" />
          {translate(
            'auto.components.session.grid.SessionsGridPage.emptyRevealAction',
            'Reveal hidden sessions'
          )}
        </Button>
      </EmptyStateFrame>
    )
  }

  if (reason === 'filtered') {
    return (
      <EmptyStateFrame
        reason={reason}
        title={translate(
          'auto.components.session.grid.SessionsGridPage.emptyFilteredTitle',
          'No session matches these filters'
        )}
        body={translate(
          'auto.components.session.grid.SessionsGridPage.emptyFilteredBody',
          'Sessions are open — the toolbar filters are keeping them off the grid.'
        )}
      >
        <Button
          size="sm"
          variant="outline"
          data-testid="session-grid-empty-clear-filters"
          onClick={onClearFilters}
          className="mt-2 gap-1.5 text-xs"
        >
          <SlidersHorizontal className="size-3.5" />
          {translate(
            'auto.components.session.grid.SessionsGridPage.emptyClearFiltersAction',
            'Clear filters'
          )}
        </Button>
      </EmptyStateFrame>
    )
  }

  return (
    <EmptyStateFrame
      reason={reason}
      title={translate(
        'auto.components.session.grid.SessionsGridPage.c406fd4604',
        'No active sessions'
      )}
      body={translate(
        'auto.components.session.grid.SessionsGridPage.02aa208e3c',
        'No terminal sessions open across any workspace.'
      )}
    >
      <Popover open={launchOpen} onOpenChange={setLaunchOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" disabled={!canLaunchFirst} className="mt-2 gap-1.5 text-xs">
            <Plus className="size-3.5" />
            {translate('auto.components.session.grid.SessionsGridPage.3b6b0870de', 'New session')}
          </Button>
        </PopoverTrigger>
        <SessionGridLaunchPopoverContent
          activeFilter={activeFilter}
          {...(defaultWorktreeId ? { defaultWorktreeId } : {})}
          worktreeCatalog={worktreeCatalog}
          gridWorktreeIds={gridWorktreeIds}
          onDone={() => setLaunchOpen(false)}
        />
      </Popover>
    </EmptyStateFrame>
  )
}
