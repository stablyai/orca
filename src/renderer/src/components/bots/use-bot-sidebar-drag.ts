import { useCallback, useMemo, type RefObject } from 'react'
import { toast } from 'sonner'
import { updateBot } from '@/lib/bot-catalog'
import { callBotRpc } from '@/lib/bot-hosts'
import { readBotHostState } from '@/lib/bot-catalog-snapshot'
import { useFloatingProjectGroupHeaderDrag } from '@/components/sidebar/worktree-list/drag/use-floating-project-group-header-drag'
import {
  ROOT_PROJECT_GROUP_HEADER_BUCKET,
  type ProjectGroupHeaderDragItem
} from '@/components/sidebar/worktree-list/drag/project-group-header-drop'
import type { HostKeyedBotSidebarEntry } from './bot-sidebar-entry-keys'
import { botErrorMessage } from './bot-presentation'

export function useBotSidebarDrag(
  entries: readonly HostKeyedBotSidebarEntry[],
  listRef: RefObject<HTMLDivElement | null>
): ReturnType<typeof useFloatingProjectGroupHeaderDrag> {
  // Bots reorder through the project-group header drag: one root bucket, each bot's order saved on its host.
  const botIdsByBucket = useMemo(
    () => new Map([[ROOT_PROJECT_GROUP_HEADER_BUCKET, entries.map(({ id }) => id)]]),
    [entries]
  )
  const dragItemById = useMemo(
    () =>
      new Map<string, ProjectGroupHeaderDragItem>(
        // An entry never placed takes no order, so the first drop writes one for every entry.
        entries.map((entry) => [
          entry.id,
          {
            parentGroupId: null,
            tabOrder: (entry.kind === 'bot' ? entry.bot : entry.group).sidebarOrder ?? -1
          }
        ])
      ),
    [entries]
  )
  const commitOrder = useCallback(
    (id: string, sidebarOrder: number) => {
      const entry = entries.find((candidate) => candidate.id === id)
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
    [entries]
  )
  return useFloatingProjectGroupHeaderDrag({
    sidebarProjectGroupHeaderIdsByBucket: botIdsByBucket,
    projectGroupById: dragItemById,
    onCommitProjectGroupTabOrder: commitOrder,
    getScrollContainer: () => listRef.current
  })
}
