// Tabs share constrained space down to 80px (TAB_MIN_WIDTH_WITH_TITLE_PX); the condense plan takes over below that.
// Terminals reserve room for changing titles.
export const TERMINAL_TAB_CONTAINER_WIDTH_CLASSES =
  'w-[var(--tab-max-width,300px)] max-w-[var(--tab-max-width,300px)] min-w-[80px] flex-auto'
// Cap intrinsic child widths too, so flex shrink starts from --tab-max-width even for very long labels.
export const CONTENT_TAB_CONTAINER_WIDTH_CLASSES =
  'w-max max-w-[var(--tab-max-width,300px)] min-w-[80px] flex-initial [&>*]:max-w-[var(--tab-max-width,300px)]'
// Fit mode sizes every tab to its title without flex shrink; overflow uses horizontal strip scrolling.
export const FIT_TAB_CONTAINER_WIDTH_CLASSES =
  'w-max max-w-[var(--tab-max-width,300px)] min-w-[80px] flex-none [&>*]:max-w-[var(--tab-max-width,300px)]'

export const TAB_LABEL_WIDTH_CLASSES = 'tab-label min-w-0 flex-1 truncate'
