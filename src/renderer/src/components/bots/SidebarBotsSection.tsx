import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { callBotRpc } from '@/lib/bot-hosts'
import { useFloatingProjectGroupHeaderDrag } from '@/components/sidebar/worktree-list/drag/use-floating-project-group-header-drag'
import {
  ROOT_PROJECT_GROUP_HEADER_BUCKET,
  type ProjectGroupHeaderDragItem
} from '@/components/sidebar/worktree-list/drag/project-group-header-drop'
import { WorktreeSidebarDropIndicator } from '@/components/sidebar/worktree-list/drag/WorktreeSidebarDropIndicator'
import { SidebarSectionHeader } from '@/components/sidebar/SidebarSectionHeader'
import { selectActiveBotGroupRoomId } from '@/lib/bot-group-catalog'
import { useBotGroups } from '@/lib/bot-group-list'
import { useTranslate } from '@/i18n/use-translate'
import { updateBot, useBotHomeWorkspaces, useBots } from '@/lib/bot-catalog'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { cn } from '@/lib/class-names'
import { BOTS_GROUP_KEY } from '../../../../shared/sidebar-list/sections/group-keys'
import {
  folderWorkspaceKey,
  getActiveSidebarWorkspaceId
} from '../../../../shared/workspace/identity/workspace-scope'
import { botGroupMemberBots } from '../../../../shared/bots/bot-sidebar-entries'
import { getHostKeyedBotSidebarEntries } from './bot-sidebar-entry-keys'
import { readBotHostState } from '@/lib/bot-catalog-snapshot'
import { BotSidebarDragFrame, BotSidebarEntry, type BotSidebarEntryDrag } from './BotSidebarEntry'
import { BotGroupRow } from './BotGroupRow'
import { useBotGroupDelete } from './use-bot-group-delete'
import { findBotGroupRoom, type BotGroup } from '../../../../shared/bots/bot-group'
import { BotSidebarNewMenu } from './BotSidebarNewMenu'
import { BotSidebarOptionsMenu } from './BotSidebarOptionsMenu'
import { useBotSidebarArrangement } from './use-bot-sidebar-arrangement'
import { botErrorMessage } from './bot-presentation'

import {
  LazyBotGroupMembersDialog,
  LazyImportBotDialog,
  LazyNewBotDialog
} from './lazy-bot-dialogs'
import { BotCollapsedPreview, useBotPreviewFacts } from './BotCollapsedPreview'
import { summarizeBotPreview } from '../../../../shared/bots/bot-collapsed-preview'
import { BotSidebarSearchButton, BotSidebarSearchHost } from './BotSidebarSearch'
import { useBotCollapseAll } from './use-bot-collapse-all'
import { useBotSidebarSearch } from './use-bot-sidebar-search'
import { BotsCollapseAllButton } from './BotsCollapseAllButton'
import { useBotsSidebarReveal } from './bots-sidebar-reveal'
import { BotsRevealProvider } from './bots-sidebar-reveal-context'
import { SidebarBotsEmptyState } from './SidebarBotsEmptyState'
import { BotSidebarVirtualRows } from './BotSidebarVirtualRows'
import { botSidebarVirtualScrollers } from './bot-sidebar-virtual-scroll'

/** Lists bots from this computer and paired servers in the sidebar. */
export function SidebarBotsSection({
  onOpenBot,
  reorderable = false
}: {
  onOpenBot: () => void
  reorderable?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const bots = useBots()
  const savedCollapsed = useAppStore((s) => s.collapsedGroups.has(BOTS_GROUP_KEY))
  const toggleCollapsedGroup = useAppStore((s) => s.toggleCollapsedGroup)
  const activeWorkspaceId = useAppStore((s) =>
    s.activeView === 'tasks' ||
    s.activeView === 'activity' ||
    selectActiveBotGroupRoomId(s) !== null
      ? null
      : getActiveSidebarWorkspaceId(s.activeWorkspaceKey, s.activeWorktreeId)
  )
  const groups = useBotGroups()
  const folderWorkspaces = useBotHomeWorkspaces(bots, groups)
  const activeRoomId = useAppStore(selectActiveBotGroupRoomId)
  const activeGroupId = activeRoomId ? findBotGroupRoom(groups, activeRoomId)?.group.id : null
  const deleteGroup = useBotGroupDelete()
  const [newBotOpen, setNewBotOpen] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const openNewBot = (): void => {
    setNewMenuOpen(false)
    setNewBotOpen(true)
  }
  const [importOpen, setImportOpen] = useState(false)
  const [editingGroup, setEditingGroup] = useState<BotGroup | 'new' | null>(null)
  const [pendingRenameKey, setPendingRenameKey] = useState<string | null>(null)
  // Bots and groups share one list and one order; the folded header shows bots only.
  const savedEntries = useMemo(
    () => getHostKeyedBotSidebarEntries(bots, groups, folderWorkspaces),
    [bots, groups, folderWorkspaces]
  )
  const entries = useBotSidebarArrangement(savedEntries)
  const listRef = useRef<HTMLDivElement>(null)
  // Search shows the list in place and nothing drags while it is open. Its toggle lives only in the
  // unfolded header, so a search always starts unfolded.
  const search = useBotSidebarSearch({ listRef, savedEntries, onOpenBot })
  const searchOpen = search.open
  // Only the saved order can be dragged, as for workspaces.
  const draggable = useAppStore((s) => s.botSidebarView.sortBy === 'manual') && !searchOpen
  const rows = useMemo(
    () => entries.flatMap((entry) => (entry.kind === 'bot' ? [entry] : [])),
    [entries]
  )
  const hasEntries = savedEntries.length > 0
  // Folds even while empty, so the onboarding card can be put away. A fold landing mid-search
  // (another writer) still leaves the results showing until the search ends.
  const collapsed = savedCollapsed && !searchOpen
  // The + menu unmounts with the folded header's controls; a fold it didn't see must not reopen it on unfold.
  if (collapsed && newMenuOpen) {
    setNewMenuOpen(false)
  }
  const collapseAll = useBotCollapseAll(entries, savedEntries)
  const facts = useBotPreviewFacts(rows)
  const preview = summarizeBotPreview(facts)
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
  const drag = useFloatingProjectGroupHeaderDrag({
    sidebarProjectGroupHeaderIdsByBucket: botIdsByBucket,
    projectGroupById: dragItemById,
    onCommitProjectGroupTabOrder: commitOrder,
    getScrollContainer: () => listRef.current
  })
  const listShown = !collapsed && entries.length > 0
  const reveal = useBotsSidebarReveal(listRef, listShown, savedEntries, search.endForReveal)
  const handleRenameFromPreview = useCallback(
    (entryKey: string) => {
      setPendingRenameKey(entryKey)
      if (useAppStore.getState().collapsedGroups.has(BOTS_GROUP_KEY)) {
        toggleCollapsedGroup(BOTS_GROUP_KEY)
      }
    },
    [toggleCollapsedGroup]
  )
  if (pendingRenameKey !== null && !entries.some((entry) => entry.id === pendingRenameKey)) {
    setPendingRenameKey(null)
  }
  useLayoutEffect(() => {
    if (!pendingRenameKey || collapsed || !listRef.current) {
      return
    }
    botSidebarVirtualScrollers.get(listRef.current)?.(pendingRenameKey)
  }, [pendingRenameKey, collapsed])
  const toggleBots = (): void => {
    if (!search.endForFold()) {
      toggleCollapsedGroup(BOTS_GROUP_KEY)
    }
  }
  const collapseLabel = collapsed
    ? t('bots.section.expand', 'Expand Bots')
    : t('bots.section.collapse', 'Collapse Bots')

  return (
    // The sidebar's SidebarBotsSplit owns this section's height cap.
    // While searching it fills the held split, so the search area can center an empty result.
    <div className={cn('flex min-h-0 flex-col', searchOpen && 'grow')}>
      {/* Each folded face is a button of its own above the shared fold button. */}
      <SidebarSectionHeader
        title={t('bots.section.title', 'Bots')}
        sectionId="bots"
        reorderable={reorderable}
        fold={{
          collapsed,
          label: t(
            'bots.section.summary',
            '{{action}}, {{total}} bots, {{attention}} need you, {{unread}} unread, {{working}} working',
            {
              action: collapseLabel,
              total: preview.total,
              attention: preview.attention,
              unread: preview.unread,
              working: preview.working
            }
          ),
          tooltip: collapseLabel,
          onToggle: toggleBots
        }}
        titleAccessory={
          !collapsed && collapseAll && !searchOpen ? (
            <BotsCollapseAllButton collapseAll={collapseAll} />
          ) : null
        }
        summary={
          collapsed ? (
            <BotCollapsedPreview
              facts={facts}
              onOpenBot={onOpenBot}
              onRenameBot={handleRenameFromPreview}
            />
          ) : null
        }
        actions={
          collapsed ? null : (
            <>
              {hasEntries ? (
                <BotSidebarSearchButton
                  open={searchOpen}
                  buttonRef={search.buttonRef}
                  onToggle={search.toggleOpen}
                />
              ) : null}
              {hasEntries ? <BotSidebarOptionsMenu /> : null}
              <BotSidebarNewMenu
                open={newMenuOpen}
                onOpenChange={setNewMenuOpen}
                canCreateGroup={bots.length >= 2}
                onNewBot={openNewBot}
                onImport={() => setImportOpen(true)}
                onNewGroup={() => setEditingGroup('new')}
              />
            </>
          )
        }
      />
      <BotSidebarSearchHost
        open={searchOpen}
        regionRef={search.regionRef}
        panel={{
          entries,
          allEntries: savedEntries,
          bots,
          onSelect: search.select,
          onSupersede: search.supersede,
          onCancel: search.cancel
        }}
      >
        <BotsRevealProvider value={reveal}>
          <div
            ref={listRef}
            data-bot-sidebar-list=""
            className={cn(
              'bot-sidebar-scrollbar relative flex min-h-0 flex-col overflow-y-auto overscroll-y-contain [overflow-anchor:none]',
              entries.length > 0 && 'pb-1 px-1',
              collapsed && 'hidden'
            )}
          >
            {/* A room kept after its last bot went still lists, so it can be opened or deleted. */}
            {savedEntries.length > 0 && entries.length === 0 ? (
              collapsed ? null : (
                <div className="px-4 text-xs text-muted-foreground">
                  {t('bots.options.allHidden', 'All bots are paused and hidden.')}
                </div>
              )
            ) : entries.length === 0 ? (
              collapsed ? null : (
                <SidebarBotsEmptyState onNewBot={openNewBot} />
              )
            ) : collapsed ? null : (
              <>
                <BotSidebarVirtualRows
                  entries={entries}
                  listRef={listRef}
                  draggingId={drag.state.draggingGroupId}
                  revealId={pendingRenameKey ?? reveal.request?.target.entryKey}
                  renderEntry={(entry, index) => {
                    const entryDrag: BotSidebarEntryDrag | undefined = draggable
                      ? {
                          index,
                          dragging: drag.state.draggingGroupId === entry.id,
                          settling: drag.state.draggingGroupId !== null,
                          offset: drag.state.previewOffsetsById?.get(entry.id) ?? 0,
                          onPointerDown: (event) => drag.onHandlePointerDown(event, entry.id)
                        }
                      : undefined
                    return entry.kind === 'group' ? (
                      <BotSidebarDragFrame id={entry.id} drag={entryDrag}>
                        <BotGroupRow
                          group={entry.group}
                          home={entry.home}
                          members={botGroupMemberBots(entry.group, bots)}
                          isActive={activeGroupId === entry.group.id}
                          onOpen={onOpenBot}
                          onManageMembers={() => setEditingGroup(entry.group)}
                          onDelete={() => void deleteGroup(entry.group)}
                          dragHandle={draggable}
                        />
                      </BotSidebarDragFrame>
                    ) : (
                      <BotSidebarEntry
                        bot={entry.bot}
                        home={entry.home}
                        isActive={activeWorkspaceId === folderWorkspaceKey(entry.home.id)}
                        onOpen={onOpenBot}
                        drag={entryDrag}
                        beginRename={pendingRenameKey === entry.id}
                        onBeginRenameConsumed={() =>
                          setPendingRenameKey((current) => (current === entry.id ? null : current))
                        }
                      />
                    )
                  }}
                />
                {drag.state.draggingGroupId !== null && drag.state.dropIndicatorY !== null ? (
                  <WorktreeSidebarDropIndicator y={drag.state.dropIndicatorY} />
                ) : null}
              </>
            )}
          </div>
        </BotsRevealProvider>
      </BotSidebarSearchHost>
      {newBotOpen ? (
        <LazyNewBotDialog
          open={newBotOpen}
          onOpenChange={setNewBotOpen}
          onCreated={onOpenBot}
          onImport={() => setImportOpen(true)}
        />
      ) : null}
      {importOpen ? (
        <LazyImportBotDialog open={importOpen} onOpenChange={setImportOpen} onCreated={onOpenBot} />
      ) : null}
      {editingGroup ? (
        <LazyBotGroupMembersDialog
          group={editingGroup === 'new' ? undefined : editingGroup}
          onClose={() => setEditingGroup(null)}
        />
      ) : null}
    </div>
  )
}
