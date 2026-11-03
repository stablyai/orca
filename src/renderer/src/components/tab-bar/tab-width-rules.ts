// Preferred widths size the content-fit strip; tabs share constrained space down to 144px.
export const TAB_CONTAINER_WIDTH_CLASSES = 'w-[300px] max-w-[300px] min-w-[144px] flex-1'

export const TAB_LABEL_WIDTH_CLASSES = 'tab-label min-w-0 flex-1 truncate'

// Why: an icon-only pinned tab shrink-wraps to its glyph so the strip reclaims the label width;
// the last-child margin reset drops the trailing gap the hidden label used to sit against.
export const TAB_ICON_ONLY_CONTAINER_WIDTH_CLASSES = 'w-auto shrink-0'
export const TAB_ICON_ONLY_ROOT_CLASSES = 'justify-center [&>*:last-child]:mr-0'
