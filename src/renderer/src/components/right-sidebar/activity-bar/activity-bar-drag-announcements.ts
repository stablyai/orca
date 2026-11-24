import type { Announcements } from '@dnd-kit/core'
import type { Translate } from '@/i18n/use-translate'
import type { ActivityBarItem } from './activity-bar-buttons'

// Screen-reader announcements for dragging a tab, named by the tab's title rather than its id.
export function activityBarDragAnnouncements(
  items: readonly ActivityBarItem[],
  t: Translate
): Announcements {
  const title = (id: string | number): string => items.find((item) => item.id === id)?.title ?? ''
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
