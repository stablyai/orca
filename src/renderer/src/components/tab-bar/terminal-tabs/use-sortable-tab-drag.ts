import { useSortable } from '@dnd-kit/sortable'
import type { TabDragItemData } from '../../tab-group/drag/tab-drag-data'
import { useTabStripDragAttributes } from '../strip/tab-strip-orientation'

/** A tab's drag handle; a fixed-first tab (a bot's Home) stays put but still takes drops. */
export function useSortableTabDrag<T extends Pick<TabDragItemData, 'fixedFirst'>>(
  id: string,
  data: T,
  isActive = false
) {
  const sortable = useSortable({
    id,
    disabled: { draggable: data.fixedFirst === true, droppable: false },
    data,
    attributes: useTabStripDragAttributes(isActive)
  })
  // Why: Home can't move but is still selectable; dnd-kit's aria-disabled would announce it as unavailable.
  const attributes = data.fixedFirst
    ? { ...sortable.attributes, 'aria-disabled': undefined }
    : sortable.attributes
  return { attributes, listeners: sortable.listeners, setNodeRef: sortable.setNodeRef }
}
