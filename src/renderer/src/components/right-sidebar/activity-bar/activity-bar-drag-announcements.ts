import type { Announcements } from '@dnd-kit/core'
import type { Translate } from '@/i18n/use-translate'
import type { ActivityBarItem } from './activity-bar-buttons'

/** The name a drag announcement uses for a tab: its accessible name, which tells colliding
 *  plugin panels apart, rather than its id. */
export function activityBarDragName(
  items: readonly ActivityBarItem[],
  id: string | number
): string {
  const item = items.find((candidate) => candidate.id === id)
  return item ? (item.accessibleTitle ?? item.title) : ''
}

// Screen-reader announcements for dragging a tab.
export function activityBarDragAnnouncements(
  items: readonly ActivityBarItem[],
  t: Translate
): Announcements {
  const title = (id: string | number): string => activityBarDragName(items, id)
  return {
    onDragStart: ({ active }) =>
      t('activityBar.dragStart', 'Picked up {{name}}', { name: title(active.id) }),
    onDragOver: ({ active, over }) =>
      over
        ? t('activityBar.dragOver', '{{name}} over {{target}}', {
            name: title(active.id),
            target: title(over.id)
          })
        : undefined,
    onDragEnd: ({ active }) =>
      t('activityBar.dragEnd', 'Dropped {{name}}', { name: title(active.id) }),
    onDragCancel: ({ active }) =>
      t('activityBar.dragCancel', 'Cancelled moving {{name}}', { name: title(active.id) })
  }
}
