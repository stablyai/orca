/**
 * Shared chrome for the full-width list tables (automations, artifacts, …).
 * Each list owns only its own column template; everything else lives here so
 * the tables cannot drift apart.
 */
export const LIST_TABLE_CONTAINER_CLASS = 'rounded-md border border-border/50 bg-muted/20'

// Why: z-30 must beat the rows' sticky first cells (z-20) so the header still covers them.
export const LIST_TABLE_HEADER_CLASS =
  'sticky top-0 z-30 h-8 items-center gap-3 border-b border-border/50 bg-muted/25 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground'

// Why: keep keyboard-selected rows clear of the sticky table header.
export const LIST_TABLE_ROW_CLASS =
  'group/list-table-row w-full min-h-11 scroll-mt-8 cursor-pointer items-center gap-3 px-3 py-3 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

export const LIST_TABLE_ROW_SELECTED_CLASS = 'bg-accent text-accent-foreground'

// Why: sticky cells must paint opaquely, so they carry the container tint flattened
// against the page instead of the alpha wash the scrolled columns would show through.
// The before:/after: strips fill the row's px-3 gutter and the gap-3 column gap, which
// the cell itself cannot reach, so scrolled columns slide fully out of sight.
const LIST_TABLE_STICKY_CELL_BASE_CLASS =
  'sticky left-3 flex min-w-0 self-stretch items-center before:absolute before:-left-3 before:top-0 before:bottom-0 before:w-3 before:bg-inherit after:absolute after:-right-3 after:top-0 after:bottom-0 after:w-3 after:bg-inherit'

export const LIST_TABLE_STICKY_HEADER_CELL_CLASS = `${LIST_TABLE_STICKY_CELL_BASE_CLASS} z-10 bg-[color-mix(in_srgb,var(--muted)_40%,var(--background))]`

// Why: hover/selection ride variants, not props, so the frozen cell tracks the row's own wash.
export const LIST_TABLE_STICKY_ROW_CELL_CLASS = `${LIST_TABLE_STICKY_CELL_BASE_CLASS} z-20 bg-[color-mix(in_srgb,var(--muted)_20%,var(--background))] transition-colors group-hover/list-table-row:bg-accent group-data-[current=true]/list-table-row:bg-accent`
