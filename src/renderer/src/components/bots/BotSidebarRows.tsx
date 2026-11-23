import { useCallback, useMemo, type RefObject } from 'react'
import { toast } from 'sonner'
import { callBotRpc } from '@/lib/bot-hosts'
import { updateBot } from '@/lib/bot-catalog'
import { readBotHostState } from '@/lib/bot-catalog-snapshot'
import { useTranslate } from '@/i18n/use-translate'
import { useFloatingProjectGroupHeaderDrag } from '@/components/sidebar/worktree-list/drag/use-floating-project-group-header-drag'
import {
  ROOT_PROJECT_GROUP_HEADER_BUCKET,
  type ProjectGroupHeaderDragItem
} from '@/components/sidebar/worktree-list/drag/project-group-header-drop'
import { WorktreeSidebarDropIndicator } from '@/components/sidebar/worktree-list/drag/WorktreeSidebarDropIndicator'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import {
  botGroupMemberBots,
  type BotSidebarEntry as Entry
} from '../../../../shared/bots/bot-sidebar-entries'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { BotSidebarDragFrame, BotSidebarEntry, type BotSidebarEntryDrag } from './BotSidebarEntry'
import { BotGroupRow } from './BotGroupRow'
import { BotSidebarVirtualRows } from './BotSidebarVirtualRows'
import type { PinnedBotColumn } from './BotSidebarRow'
import { botErrorMessage } from './bot-presentation'

type EntryData = Entry<Bot, BotGroup, FolderWorkspace>
type SidebarRow =
  | { id: string; kind: 'pinned'; first: EntryData; second?: EntryData }
  | { id: string; kind: 'list'; entry: EntryData; index: number }

function getEntryIds(row: SidebarRow): string[] {
  return row.kind === 'pinned' && row.second ? [row.second.id] : []
}

export function BotSidebarRows({
  entries,
  bots,
  listRef,
  draggable,
  activeWorkspaceId,
  activeGroupId,
  revealId,
  onOpenBot,
  onManageGroup,
  onDeleteGroup
}: {
  entries: readonly EntryData[]
  bots: readonly Bot[]
  listRef: RefObject<HTMLDivElement | null>
  draggable: boolean
  activeWorkspaceId: string | null
  activeGroupId: string | null
  revealId: string | undefined
  onOpenBot: () => void
  onManageGroup: (group: BotGroup) => void
  onDeleteGroup: (group: BotGroup) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { rows, regular } = useMemo(() => {
    const pinned = entries.filter((entry) => entry.home.isPinned)
    const regular = entries.filter((entry) => !entry.home.isPinned)
    const rows: SidebarRow[] = []
    for (let index = 0; index < pinned.length; index += 2) {
      const first = pinned[index]!
      rows.push({ id: first.id, kind: 'pinned', first, second: pinned[index + 1] })
    }
    regular.forEach((entry, index) => rows.push({ id: entry.id, kind: 'list', entry, index }))
    return { rows, regular }
  }, [entries])
  const botIdsByBucket = useMemo(
    () => new Map([[ROOT_PROJECT_GROUP_HEADER_BUCKET, regular.map(({ id }) => id)]]),
    [regular]
  )
  const dragItemById = useMemo(
    () =>
      new Map<string, ProjectGroupHeaderDragItem>(
        regular.map((entry) => [
          entry.id,
          {
            parentGroupId: null,
            tabOrder: (entry.kind === 'bot' ? entry.bot : entry.group).sidebarOrder ?? -1
          }
        ])
      ),
    [regular]
  )
  const commitOrder = useCallback(
    (id: string, sidebarOrder: number) => {
      const entry = regular.find((candidate) => candidate.id === id)
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
    [regular]
  )
  const drag = useFloatingProjectGroupHeaderDrag({
    sidebarProjectGroupHeaderIdsByBucket: botIdsByBucket,
    projectGroupById: dragItemById,
    onCommitProjectGroupTabOrder: commitOrder,
    getScrollContainer: () => listRef.current
  })

  const renderEntry = (
    entry: EntryData,
    pinnedColumn?: PinnedBotColumn,
    entryDrag?: BotSidebarEntryDrag
  ): React.JSX.Element =>
    entry.kind === 'group' ? (
      <BotSidebarDragFrame
        key={entry.id}
        id={entry.id}
        drag={entryDrag}
        pinned={pinnedColumn !== undefined}
      >
        <BotGroupRow
          group={entry.group}
          home={entry.home}
          members={botGroupMemberBots(entry.group, bots)}
          isActive={activeGroupId === entry.group.id}
          onOpen={onOpenBot}
          onManageMembers={() => onManageGroup(entry.group)}
          onDelete={() => onDeleteGroup(entry.group)}
          dragHandle={entryDrag !== undefined}
          pinnedColumn={pinnedColumn}
        />
      </BotSidebarDragFrame>
    ) : (
      <BotSidebarEntry
        key={entry.id}
        bot={entry.bot}
        home={entry.home}
        isActive={activeWorkspaceId === folderWorkspaceKey(entry.home.id)}
        onOpen={onOpenBot}
        drag={entryDrag}
        pinnedColumn={pinnedColumn}
      />
    )

  return (
    <>
      <BotSidebarVirtualRows
        entries={rows}
        listRef={listRef}
        draggingId={drag.state.draggingGroupId}
        revealId={revealId}
        getEntryIds={getEntryIds}
        renderEntry={(row, index) => {
          if (row.kind === 'pinned') {
            return (
              <div className="px-1.5 pb-1.5">
                {index === 0 ? (
                  <h3 className="px-0.5 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">
                    {t('bots.section.pinned', 'Pinned')}
                  </h3>
                ) : null}
                <div data-bot-pinned-row="" className="grid grid-cols-2 gap-1.5">
                  {renderEntry(row.first, 1)}
                  {row.second ? renderEntry(row.second, 2) : null}
                </div>
              </div>
            )
          }
          const entryDrag: BotSidebarEntryDrag | undefined = draggable
            ? {
                index: row.index,
                dragging: drag.state.draggingGroupId === row.id,
                settling: drag.state.draggingGroupId !== null,
                offset: drag.state.previewOffsetsById?.get(row.id) ?? 0,
                onPointerDown: (event) => drag.onHandlePointerDown(event, row.id)
              }
            : undefined
          return renderEntry(row.entry, undefined, entryDrag)
        }}
      />
      {drag.state.draggingGroupId !== null && drag.state.dropIndicatorY !== null ? (
        <WorktreeSidebarDropIndicator y={drag.state.dropIndicatorY} />
      ) : null}
    </>
  )
}
