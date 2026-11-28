// Share list-table chrome to prevent drift; lists supply only column templates.
// `--list-table-gutter` (default 12px) is the row's side padding and the sticky cells' offset; a rail page sets it
// to its page gutter so rows, headers and hairlines share the page's edges without padding the scroller.
// Why: z-30 and opaque wash ensure scrolled rows cannot show through the sticky header.
export const LIST_TABLE_HEADER_CLASS =
  'sticky top-0 z-30 h-8 items-center gap-3 border-b border-border/50 bg-[color-mix(in_srgb,var(--muted)_40%,var(--background))] ps-[var(--list-table-gutter,0.75rem)] pe-[var(--list-table-gutter-end,var(--list-table-gutter,0.75rem))] text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground'

// Why: keep keyboard-selected rows clear of the sticky table header.
export const LIST_TABLE_ROW_CLASS =
  'group/list-table-row w-full min-h-11 scroll-mt-8 cursor-pointer items-center gap-3 ps-[var(--list-table-gutter,0.75rem)] pe-[var(--list-table-gutter-end,var(--list-table-gutter,0.75rem))] py-3 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

export const LIST_TABLE_ROW_SELECTED_CLASS = 'bg-accent text-accent-foreground'

// Flatten tint for opaque sticky cells; pseudo-element strips cover gutters/gaps so scrolled columns cannot show through.
const LIST_TABLE_STICKY_CELL_BASE_CLASS =
  'sticky left-[var(--list-table-gutter,0.75rem)] flex min-w-0 self-stretch items-center before:absolute before:left-[calc(var(--list-table-gutter,0.75rem)*-1)] before:top-0 before:bottom-0 before:w-[var(--list-table-gutter,0.75rem)] before:bg-inherit after:absolute after:-right-3 after:top-0 after:bottom-0 after:w-3 after:bg-inherit'

export const LIST_TABLE_STICKY_HEADER_CELL_CLASS = `${LIST_TABLE_STICKY_CELL_BASE_CLASS} z-10 bg-[color-mix(in_srgb,var(--muted)_40%,var(--background))]`

// Why: hover/selection ride variants, not props, so the frozen cell tracks the row's own wash.
export const LIST_TABLE_STICKY_ROW_CELL_CLASS = `${LIST_TABLE_STICKY_CELL_BASE_CLASS} z-20 bg-background transition-colors group-hover/list-table-row:bg-accent group-data-[current=true]/list-table-row:bg-accent`

// Absolute virtual rows need individual bottom separators; compositing over each row preserves its selection wash beneath the hairline.
export const LIST_TABLE_ROW_DIVIDER_CLASS = 'border-b border-border/50'
