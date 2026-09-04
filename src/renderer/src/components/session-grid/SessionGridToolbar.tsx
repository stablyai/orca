import React, { memo, useCallback, useMemo, useState } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type {
  SessionGridFilter,
  SessionGridStateFilter
} from '../../../../shared/session-grid-types'
import type { SessionGridBucketCounts, SessionGridFilterOption } from './session-grid-items-builder'
import type { SessionGridWorktreeCatalog } from './session-grid-worktree-catalog'
import { SessionGridLaunchPopoverContent } from './SessionGridLaunchPicker'
import { SessionGridStateCompactMenu, SessionGridStateSegments } from './SessionGridStateControl'
import { SessionGridViewMenu, SessionGridZoomStepper } from './SessionGridViewMenu'
import { SessionGridWorkspacePicker } from './SessionGridWorkspacePicker'
import { translate } from '@/i18n/i18n'

type SessionGridToolbarProps = {
  filterOptions: SessionGridFilterOption[]
  activeFilter: SessionGridFilter
  stateCounts: SessionGridBucketCounts
  activeStateFilter: SessionGridStateFilter
  hiddenCount: number
  revealHidden: boolean
  onToggleReveal: () => void
  worktreeCatalog: SessionGridWorktreeCatalog
  /** The active workspace, which the launcher leads with when the grid is not filtered. */
  defaultWorktreeId?: string
  currentPage: number
  totalPages: number
  onPageChange: (page: number) => void
  onBack: () => void
}

/**
 * One row, never scrolled. Scope and state on the left because together they are one
 * query ("in orca / main, the ones Working"); pager, zoom and the view menu on the right.
 *
 * The row is its own `@container/toolbar`, so every collapse below keys on the space the
 * sidebar leaves it and not on the window. Every collapse is a `max` variant with `!hidden`,
 * the spelling task-page-jira-sort-controls and IssueList already use: react-grab's dev
 * stylesheet ships its own Tailwind utilities in the same layer and loads after main.css, so
 * a plain layered `hidden`/`inline-flex` pair loses to it by source order in `pn dev`. The thresholds come from measuring the content,
 * not from round numbers: the zoom stepper goes first, under 1024 px; the segment labels
 * under 896 px, where the full row stops fitting with the longest catalog in use; the two
 * wordy buttons drop to icons under 672 px; under 576 px, where five glyph-and-count
 * segments stop fitting, the segmented control folds into one dropdown; and under 384 px
 * that dropdown's own count and chevron go, which is what a 600 px window with the sidebar
 * open (320 px left) needs. Nothing is lost on the way down — what leaves the row already
 * has a copy in a menu.
 *
 * Memoized on purpose: the page re-renders on every agent-status burst through its own
 * store bundles, and without this the whole toolbar re-rendered ~30 times a second with
 * identical content. The memo only pays off because the builder hands back the same
 * `filterOptions` and `stateCounts` objects when nothing moved; the two halves are one fix.
 */
export const SessionGridToolbar = memo(function SessionGridToolbar({
  filterOptions,
  activeFilter,
  stateCounts,
  activeStateFilter,
  hiddenCount,
  revealHidden,
  onToggleReveal,
  worktreeCatalog,
  defaultWorktreeId,
  currentPage,
  totalPages,
  onPageChange,
  onBack
}: SessionGridToolbarProps): React.JSX.Element {
  const [launchOpen, setLaunchOpen] = useState(false)
  const closeLaunch = useCallback(() => setLaunchOpen(false), [])
  // The workspaces with a card on the grid, in the order the chips used to list them.
  const gridWorktreeIds = useMemo(
    () => filterOptions.filter((option) => option.id !== 'all').map((option) => option.id),
    [filterOptions]
  )
  const backLabel = translate(
    'auto.components.session.grid.SessionGridToolbar.b99757367b',
    'Back to workspace'
  )
  const newSessionLabel = translate(
    'auto.components.session.grid.SessionGridToolbar.71bc1856d3',
    'New session'
  )

  return (
    <div className="@container/toolbar flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border bg-card/60 px-3 backdrop-blur select-none @max-xl/toolbar:gap-2 @max-xl/toolbar:px-2">
      <div className="flex min-w-0 items-center gap-1.5 @max-xl/toolbar:gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={onBack}
              aria-label={backLabel}
            >
              <ArrowLeft className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {backLabel}
          </TooltipContent>
        </Tooltip>

        <Popover open={launchOpen} onOpenChange={setLaunchOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-testid="session-grid-new-session"
                  className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label={newSessionLabel}
                >
                  <Plus className="size-4" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {newSessionLabel}
            </TooltipContent>
          </Tooltip>
          <SessionGridLaunchPopoverContent
            activeFilter={activeFilter}
            {...(defaultWorktreeId ? { defaultWorktreeId } : {})}
            worktreeCatalog={worktreeCatalog}
            gridWorktreeIds={gridWorktreeIds}
            onDone={closeLaunch}
            align="start"
            sideOffset={6}
          />
        </Popover>

        <div className="mx-0.5 h-4 w-px shrink-0 bg-border @max-xl/toolbar:!hidden" />

        <SessionGridWorkspacePicker
          filterOptions={filterOptions}
          activeFilter={activeFilter}
          worktreeCatalog={worktreeCatalog}
        />

        <SessionGridStateSegments
          stateCounts={stateCounts}
          activeStateFilter={activeStateFilter}
          className="@max-xl/toolbar:!hidden"
        />
        <SessionGridStateCompactMenu
          stateCounts={stateCounts}
          activeStateFilter={activeStateFilter}
          className="@xl/toolbar:!hidden"
        />
      </div>

      <div className="flex shrink-0 items-center gap-2 @max-xl/toolbar:gap-1">
        {/* Always mounted, so the row does not change width as pages come and go. */}
        <div className="flex h-7 items-center gap-0.5 rounded-md border border-border/40 bg-muted/40 px-1 text-xs text-muted-foreground">
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground disabled:opacity-30"
            disabled={currentPage <= 0}
            onClick={() => onPageChange(currentPage - 1)}
            aria-label={translate(
              'auto.components.session.grid.SessionGridToolbar.b0fdffe943',
              'Previous page'
            )}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <span className="inline-flex h-6 items-center justify-center px-1 pt-[1px] font-mono text-[11px] leading-none tabular-nums text-foreground/80 select-none">
            {currentPage + 1} / {Math.max(totalPages, 1)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground disabled:opacity-30"
            disabled={currentPage >= totalPages - 1}
            onClick={() => onPageChange(currentPage + 1)}
            aria-label={translate(
              'auto.components.session.grid.SessionGridToolbar.7d252cff08',
              'Next page'
            )}
          >
            <ChevronRight className="size-3.5" />
          </Button>
        </div>

        <SessionGridZoomStepper className="@max-5xl/toolbar:!hidden" />

        <SessionGridViewMenu
          hiddenCount={hiddenCount}
          revealHidden={revealHidden}
          onToggleReveal={onToggleReveal}
        />
      </div>
    </div>
  )
})
