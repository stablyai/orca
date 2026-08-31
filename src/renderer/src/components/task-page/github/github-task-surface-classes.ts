import { cn } from '@/lib/utils'

export const GITHUB_TASK_GRID_CLASS =
  'min-w-[790px] grid-cols-[72px_minmax(320px,1fr)_84px_100px_92px_122px]'
export const GITHUB_PR_TASK_GRID_CLASS =
  'min-w-[1020px] grid-cols-[72px_minmax(360px,2fr)_132px_128px_132px_92px_158px]'
// Why: sticky cells need the row's opaque, animated surface to prevent bleed and hover flashes.
export const GITHUB_TASK_ROW_SURFACE_CLASS = 'bg-background transition-colors'
export const GITHUB_TASK_ROW_HOVER_SURFACE_CLASS = 'group-hover/github-task-row:bg-accent'
export const GITHUB_TASK_HEADER_SURFACE_CLASS =
  '[background:color-mix(in_srgb,var(--muted)_25%,var(--background))]'

// Why: opaque sticky headers and a padding-gap cover prevent vertical and horizontal bleed.
export const GITHUB_TASK_STICKY_ID_HEADER_CLASS = cn(
  // Why: full-height flex keeps the sticky fill from shrinking around its label.
  'sticky left-3 z-30 flex items-center before:absolute before:-left-3 before:top-0 before:bottom-0 before:w-3 before:bg-inherit',
  GITHUB_TASK_HEADER_SURFACE_CLASS
)
export const GITHUB_TASK_STICKY_TITLE_HEADER_CLASS = cn(
  'sticky left-[92px] z-30 flex items-center border-r border-border/40 before:absolute before:-left-2 before:top-0 before:bottom-0 before:w-2 before:bg-inherit',
  GITHUB_TASK_HEADER_SURFACE_CLASS
)
export const GITHUB_TASK_STICKY_ID_CELL_CLASS = cn(
  'sticky left-3 z-20 flex items-center before:absolute before:-left-3 before:top-0 before:bottom-0 before:w-3 before:bg-inherit',
  GITHUB_TASK_ROW_SURFACE_CLASS,
  GITHUB_TASK_ROW_HOVER_SURFACE_CLASS
)
export const GITHUB_TASK_STICKY_TITLE_CELL_CLASS = cn(
  'sticky left-[92px] z-20 flex min-w-0 flex-col justify-center border-r border-border/40 pr-2 before:absolute before:-left-2 before:top-0 before:bottom-0 before:w-2 before:bg-inherit',
  GITHUB_TASK_ROW_SURFACE_CLASS,
  GITHUB_TASK_ROW_HOVER_SURFACE_CLASS
)
