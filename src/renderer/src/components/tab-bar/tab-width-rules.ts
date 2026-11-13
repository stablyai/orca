// Tabs share constrained space down to 144px; terminals reserve room for changing titles.
export const TERMINAL_TAB_CONTAINER_WIDTH_CLASSES =
  'w-[300px] max-w-[300px] min-w-[144px] flex-auto'
// Cap intrinsic child widths too, so flex shrink starts from 300px even for very long labels.
export const CONTENT_TAB_CONTAINER_WIDTH_CLASSES =
  'w-max max-w-[300px] min-w-[144px] flex-initial [&>*]:max-w-[300px]'

/** Matches the horizontal tab row height so both placements fit the same density. */
export const VERTICAL_TAB_CONTAINER_CLASSES = 'h-8 w-full shrink-0'

export const TAB_LABEL_WIDTH_CLASSES = 'tab-label min-w-0 flex-1 truncate'
