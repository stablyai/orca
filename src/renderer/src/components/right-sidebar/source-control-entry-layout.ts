// Why: row action buttons host Radix Tooltip triggers. Keeping the overlay
// measurable prevents transient top-left tooltip placement during hover.
export const SOURCE_CONTROL_ROW_ACTION_OVERLAY_CLASS =
  'absolute right-0 top-0 bottom-0 flex shrink-0 items-center gap-1.5 bg-accent pr-3 pl-2 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto'

export const SOURCE_CONTROL_TREE_INDENT_PX = 12
export const SOURCE_CONTROL_TREE_DIRECTORY_PADDING_PX = 8
export const SOURCE_CONTROL_TREE_FILE_PADDING_PX = 20
