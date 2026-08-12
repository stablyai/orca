// Why: the strip shrink-wraps its tabs, so a content-derived width lets one live title update
// resize every tab; a definite width pins them and flex-shrink still narrows to the floor.
export const TAB_CONTAINER_WIDTH_CLASSES = 'w-[180px] min-w-[88px] min-[1280px]:w-[220px]'

export const TAB_LABEL_WIDTH_CLASSES = 'min-w-0 flex-1 truncate'
