// Tabs share constrained space down to 144px; terminals reserve room for changing titles.
export const TERMINAL_TAB_CONTAINER_WIDTH_CLASSES =
  'w-[300px] max-w-[300px] min-w-[144px] flex-auto'
// Cap intrinsic child widths too, so flex shrink starts from 300px even for very long labels.
export const CONTENT_TAB_CONTAINER_WIDTH_CLASSES =
  'w-max max-w-[300px] min-w-[144px] flex-initial [&>*]:max-w-[300px]'

export const TAB_LABEL_WIDTH_CLASSES = 'tab-label min-w-0 flex-1 truncate'

/** Height of one vertical-list row; `VERTICAL_TAB_ROW_PX` windows the list by it. */
export const VERTICAL_TAB_ROW_PX = 32
export const VERTICAL_TAB_ROW_CLASSES = 'h-8 w-full flex-none'
