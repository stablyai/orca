import React from 'react'
import { cn } from '@/lib/class-names'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SidebarSectionFoldChevron } from './sidebar-section-fold'

export type SidebarSectionFold = {
  collapsed: boolean
  /** Spoken action, e.g. "Collapse Projects". */
  label: string
  /** Hover text when the spoken label carries more than the action; defaults to `label`. */
  tooltip?: string
  onToggle: () => void
  /** Nothing to fold yet: the button stays inert and the arrow is hidden. */
  disabled?: boolean
}

type SidebarSectionHeaderProps = {
  title: string
  /** Names the section for tests and tours, e.g. `projects`. */
  sectionId: string
  /** The section's controls on the right; null leaves the row to the title and its summary. */
  actions: React.ReactNode
  /** Makes the title area a fold button; Bots and Projects share it. */
  fold?: SidebarSectionFold
  /** Shown after the title, e.g. a count or folded preview. */
  summary?: React.ReactNode
  /** A control right after the title; positioned so it stays clickable over the fold button. */
  titleAccessory?: React.ReactNode
  tourTarget?: string
}

/** A top-level sidebar section's header row: its title on the left, its controls on the right. */
export function SidebarSectionHeader({
  title,
  sectionId,
  actions,
  fold,
  summary,
  titleAccessory,
  tourTarget
}: SidebarSectionHeaderProps): React.JSX.Element {
  const showChevron = fold !== undefined && !fold.disabled
  return (
    <div className="group/sidebar-header mt-2 flex h-8 min-w-0 shrink-0 items-center justify-between gap-1.5 px-2">
      <div
        className={cn(
          'flex min-w-0 items-center gap-1',
          // The fold button spans the free header width; group/section-header lets summaries react to it.
          fold && 'group/section-header relative h-full flex-1'
        )}
        data-sidebar-section={fold ? sectionId : undefined}
        data-contextual-tour-target={tourTarget}
      >
        {fold ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="peer absolute inset-0 rounded-md focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                aria-label={fold.label}
                aria-expanded={!fold.collapsed}
                disabled={fold.disabled}
                data-sidebar-section-fold={sectionId}
                onClick={(event) => {
                  fold.onToggle()
                  // A clicked header must not keep focus once the pointer leaves.
                  if (event.detail > 0) {
                    event.currentTarget.blur()
                  }
                }}
              />
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start" sideOffset={6}>
              {fold.tooltip ?? fold.label}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {showChevron ? <SidebarSectionFoldChevron collapsed={fold.collapsed} /> : null}
        <span
          // Truncate localized titles because fixed-width actions cannot shrink inside the short header row.
          className={cn(
            'min-w-0 truncate select-none pr-0.5 text-xs font-semibold text-muted-foreground/80',
            showChevron ? 'pl-0' : 'pl-2',
            fold && 'pointer-events-none'
          )}
          data-sidebar-section-title={sectionId}
        >
          {title}
        </span>
        {titleAccessory}
        {summary}
      </div>
      {actions == null ? null : <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  )
}
