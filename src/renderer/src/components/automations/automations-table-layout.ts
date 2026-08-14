/** Shared layout classes for the automations list table.
 * Matches AutomationRunHistory / ExternalAutomationRunTable / Tasks list tables. */
// Name | Schedule | Project | Next run | Last run | Status | Agent | Actions
export const AUTOMATIONS_TABLE_GRID_CLASS =
  'grid grid-cols-[minmax(0,1.4fr)_minmax(7.5rem,10rem)_minmax(4.5rem,8rem)_minmax(8.5rem,1fr)_minmax(8rem,11rem)_minmax(4.5rem,6rem)_2.5rem_2.5rem]'

export const AUTOMATIONS_TABLE_CONTAINER_CLASS = 'rounded-md border border-border/50 bg-muted/20'

export const AUTOMATIONS_TABLE_HEADER_CLASS =
  'sticky top-0 z-10 h-8 items-center gap-3 border-b border-border/50 bg-muted/25 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground'

export const AUTOMATIONS_TABLE_ROW_CLASS =
  'w-full min-h-11 cursor-pointer items-center gap-3 px-3 py-3 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

export const AUTOMATIONS_TABLE_ROW_SELECTED_CLASS = 'bg-accent text-accent-foreground'
