// Tabs share constrained space down to 80px (TAB_MIN_WIDTH_WITH_TITLE_PX); the condense plan takes over below that.
// Terminals reserve room for changing titles.
export const TERMINAL_TAB_CONTAINER_WIDTH_CLASSES = 'w-[300px] max-w-[300px] min-w-[80px] flex-auto'
// Cap intrinsic child widths too, so flex shrink starts from 300px even for very long labels.
export const CONTENT_TAB_CONTAINER_WIDTH_CLASSES =
  'w-max max-w-[300px] min-w-[80px] flex-initial [&>*]:max-w-[300px]'

export const TAB_LABEL_WIDTH_CLASSES = 'tab-label min-w-0 flex-1 truncate'
