import { cn } from '@/lib/utils'

/** Chrome shared by the tab-strip action buttons (quick commands, open-in apps) so they stay visually identical. */
export const TAB_BAR_ACTION_BUTTON_CLASS =
  'my-auto flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

export const TAB_BAR_SPLIT_BUTTON_CLASS =
  'my-auto flex h-7 shrink-0 items-stretch overflow-hidden rounded-md border border-border/60 text-muted-foreground'

const TAB_BAR_SPLIT_BUTTON_INNER_CLASS =
  'flex items-center bg-transparent leading-none text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50'

export const TAB_BAR_SPLIT_BUTTON_PRIMARY_CLASS = cn(
  TAB_BAR_SPLIT_BUTTON_INNER_CLASS,
  'gap-1.5 rounded-l-md rounded-r-none px-1.5'
)

export const TAB_BAR_SPLIT_BUTTON_CHEVRON_CLASS = cn(
  TAB_BAR_SPLIT_BUTTON_INNER_CLASS,
  'justify-center rounded-l-none rounded-r-md border-l border-border/60 px-1'
)

export const TAB_BAR_SPLIT_BUTTON_LABEL_CLASS = 'max-w-[160px] truncate text-[12px] font-medium'
