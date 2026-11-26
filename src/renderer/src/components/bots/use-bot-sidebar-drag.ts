import { useCallback, useMemo, type RefObject } from 'react'
import { toast } from 'sonner'
import { updateBot } from '@/lib/bot-catalog'
import { callBotRpc } from '@/lib/bot-hosts'
import { readBotHostState } from '@/lib/bot-catalog-snapshot'
import { useFloatingProjectGroupHeaderDrag } from '@/components/sidebar/worktree-list/drag/use-floating-project-group-header-drag'
import type { ProjectGroupDragState } from '@/components/sidebar/worktree-list/drag/project-group-header-drag-contract'
import type { HostKeyedBotSidebarEntry } from './bot-sidebar-entry-keys'
import { botSidebarFolderDrag, type BotSidebarFolder } from './bot-group-folders'
import type { BotSidebarEntryDrag } from './BotSidebarEntry'
import { botErrorMessage } from './bot-presentation'

export type BotSidebarDrag = {
  state: ProjectGroupDragState
  /** The top-level row holding the dragged row, kept rendered while it drags. */
  draggingFolderId: string | null
  /** A row's drag by its drag id; none while the list doesn't drag. */
  dragOf: (id: string) => BotSidebarEntryDrag | undefined
}

/** Manual sort's drag: each row's order is saved on its host, within the rows it trades places with. */
export function useBotSidebarDrag(
  folders: readonly BotSidebarFolder<HostKeyedBotSidebarEntry>[],
  listRef: RefObject<HTMLDivElement | null>,
  draggable: boolean
): BotSidebarDrag {
  // Bots reorder through the project-group header drag: groups and ungrouped bots in the root
  // bucket, each unfolded group's members in a bucket of their own.
  const folderDrag = useMemo(
    () =>
      botSidebarFolderDrag(
        folders,
        (entry) => (entry.kind === 'bot' ? entry.bot : entry.group).sidebarOrder
      ),
    [folders]
  )
  const commitOrder = useCallback(
    (id: string, sidebarOrder: number) => {
      const entry = folderDrag.items.get(id)?.entry
      // A disconnected server's rows keep their place; a first drop doesn't write to them.
      if (
        !entry ||
        readBotHostState((entry.kind === 'bot' ? entry.bot : entry.group).hostId) !== 'live'
      ) {
        return
      }
      const saved =
        entry.kind === 'group'
          ? callBotRpc(entry.group, 'bots.groups.reorder', {
              groupId: entry.group.id,
              sidebarOrder
            })
          : updateBot(entry.bot, { sidebarOrder })
      saved.catch((error: unknown) => toast.error(botErrorMessage(error)))
    },
    [folderDrag]
  )
  const drag = useFloatingProjectGroupHeaderDrag({
    sidebarProjectGroupHeaderIdsByBucket: folderDrag.idsByBucket,
    projectGroupById: folderDrag.items,
    onCommitProjectGroupTabOrder: commitOrder,
    getScrollContainer: () => listRef.current
  })
  const { state, onHandlePointerDown } = drag
  const draggingId = state.draggingGroupId
  return {
    state,
    draggingFolderId:
      draggingId === null ? null : (folderDrag.items.get(draggingId)?.folderId ?? null),
    dragOf: (id) => {
      const item = folderDrag.items.get(id)
      return draggable && item
        ? {
            id,
            bucket: item.bucket,
            index: item.index,
            dragging: draggingId === id,
            settling: draggingId !== null,
            offset: state.previewOffsetsById?.get(id) ?? 0,
            onPointerDown: (event) => onHandlePointerDown(event, id)
          }
        : undefined
    }
  }
}
