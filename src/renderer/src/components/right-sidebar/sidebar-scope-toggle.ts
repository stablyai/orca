// Why: match ToggleGroup's spacing+outline qualifiers so selected edges out-specify its border-l-0 collapse.
const SIDEBAR_SCOPE_SELECTED_EDGE_CLASS =
  'data-[spacing=0]:data-[variant=outline]:aria-[checked=true]:border-l data-[spacing=0]:data-[variant=outline]:data-[state=on]:border-l'

/** Segmented scope switch shared by right-sidebar panels (Session History, Agent context). */
export const SIDEBAR_SCOPE_TOGGLE_ITEM_CLASS = `h-7 min-h-7 min-w-0 flex-1 basis-0 shrink border border-transparent bg-transparent px-2.5 text-[11px] font-medium leading-none text-foreground shadow-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-[checked=true]:border-foreground/20 aria-[checked=true]:bg-foreground/10 aria-[checked=true]:text-foreground aria-[checked=true]:shadow-xs aria-[checked=true]:hover:bg-foreground/15 aria-[checked=true]:hover:text-foreground data-[state=on]:border-foreground/20 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground data-[state=on]:shadow-xs data-[state=on]:hover:bg-foreground/15 data-[state=on]:hover:text-foreground ${SIDEBAR_SCOPE_SELECTED_EDGE_CLASS}`

export const SIDEBAR_SCOPE_TOGGLE_GROUP_CLASS =
  'h-7 w-full rounded-md border border-sidebar-border bg-sidebar-accent/35 shadow-xs'
