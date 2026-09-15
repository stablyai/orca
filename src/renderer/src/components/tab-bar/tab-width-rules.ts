// Why: the strip shrink-wraps its tabs, so a content-derived width lets one live title update
// resize every tab; a definite width pins them and flex-shrink still narrows to the floor.
export const TAB_CONTAINER_WIDTH_CLASSES = 'w-[180px] min-w-[72px] min-[1280px]:w-[220px]'

export const TAB_LABEL_WIDTH_CLASSES = 'min-w-0 flex-1 truncate'

// Why: an icon-only pinned tab shrink-wraps to its glyph so the strip reclaims the label width;
// the last-child margin reset drops the trailing gap the hidden label used to sit against.
export const TAB_ICON_ONLY_CONTAINER_WIDTH_CLASSES = 'w-auto shrink-0'
export const TAB_ICON_ONLY_ROOT_CLASSES = 'justify-center [&>*:last-child]:mr-0'
