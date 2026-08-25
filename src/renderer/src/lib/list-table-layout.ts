/**
 * Shared chrome for the full-width list tables (automations, artifacts, …).
 * Each list owns only its own column template; everything else lives here so
 * the tables cannot drift apart.
 */
export const LIST_TABLE_CONTAINER_CLASS = 'rounded-md border border-border/50 bg-muted/20'

export const LIST_TABLE_HEADER_CLASS =
  'sticky top-0 z-10 h-8 items-center gap-3 border-b border-border/50 bg-muted/25 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground'

export const LIST_TABLE_ROW_CLASS =
  'w-full min-h-11 cursor-pointer items-center gap-3 px-3 py-3 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

export const LIST_TABLE_ROW_SELECTED_CLASS = 'bg-accent text-accent-foreground'
