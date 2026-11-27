import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { callBotRpc } from '@/lib/bot-hosts'
import { useFloatingProjectGroupHeaderDrag } from '@/components/sidebar/worktree-list/drag/use-floating-project-group-header-drag'
import { getProjectGroupHeaderDragBucketKey } from '@/components/sidebar/worktree-list/drag/project-group-header-drop'
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
import { getActiveSidebarWorkspaceId } from '../../../../shared/workspace/identity/workspace-scope'
import { botSidebarEntryKey, getHostKeyedBotSidebarEntries } from './bot-sidebar-entry-keys'
import { readBotHostState } from '@/lib/bot-catalog-snapshot'
import type { BotSidebarEntryDrag } from './BotSidebarEntry'
import { BotSidebarTreeEntry } from './BotSidebarTreeEntry'
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
import { BotFolderDialogs, type BotFolderDialogState } from './BotFolderDialogs'
import { BotGroupMoveDialog } from './BotGroupMoveDialog'
import { getBotSidebarGroupFoldKey } from '../../../../shared/bots/bot-sidebar-group-parents'
import { useBotSidebarFolderRows } from './use-bot-sidebar-folder-rows'
import { getBotSidebarFolderGroupKey } from '../../../../shared/bots/bot-sidebar-folders'
import { moveBotGroupInSidebar, unfoldBotSidebarEntry } from './unfold-bot-sidebar-folders'

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
  const activeGroup = activeRoomId ? findBotGroupRoom(groups, activeRoomId)?.group : undefined
  const activeGroupId = activeGroup ? botSidebarEntryKey(activeGroup) : null
  const deleteGroup = useBotGroupDelete()
  const [newBotOpen, setNewBotOpen] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const openNewBot = (): void => {
    setNewMenuOpen(false)
    setNewBotOpen(true)
  }
  const [importOpen, setImportOpen] = useState(false)
  const [editingGroup, setEditingGroup] = useState<BotGroup | { parentKey: string | null } | null>(
    null
  )
  const subgroupParent =
    editingGroup && 'parentKey' in editingGroup
      ? groups.find((group) => botSidebarEntryKey(group) === editingGroup.parentKey)
      : undefined
  const [movingGroup, setMovingGroup] = useState<BotGroup | null>(null)
  const [folderDialog, setFolderDialog] = useState<BotFolderDialogState | null>(null)
  const [pendingRenameKey, setPendingRenameKey] = useState<string | null>(null)
  // Bots and groups share one list and one order; the folded header shows bots only.
  const savedEntries = useMemo(
    () => getHostKeyedBotSidebarEntries(bots, groups, folderWorkspaces),
    [bots, groups, folderWorkspaces]
  )
  const entries = useBotSidebarArrangement(savedEntries)
  const { treeRows, botIdsByBucket, dragItemById, memberKeysByGroup, hasFolders } =
    useBotSidebarFolderRows(entries, groups)
  const membersByGroup = useMemo(() => {
    const byKey = new Map(bots.map((bot) => [botSidebarEntryKey(bot), bot]))
    return new Map(
      [...memberKeysByGroup].map(([groupId, keys]) => [
        groupId,
        keys.flatMap((key) => byKey.get(key) ?? [])
      ])
    )
  }, [bots, memberKeysByGroup])
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
  const listShown = !collapsed && treeRows.length > 0
  const reveal = useBotsSidebarReveal(listRef, listShown, savedEntries, search.endForReveal)
  const handleRenameFromPreview = useCallback((entryKey: string) => {
    setPendingRenameKey(entryKey)
    unfoldBotSidebarEntry(entryKey)
  }, [])
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
                onNewGroup={() => setEditingGroup({ parentKey: null })}
                onNewFolder={() => setFolderDialog({ type: 'create', parentId: null })}
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
              treeRows.length > 0 && 'pb-1 px-1',
              collapsed && 'hidden'
            )}
          >
            {/* A room kept after its last bot went still lists, so it can be opened or deleted. */}
            {savedEntries.length > 0 && treeRows.length === 0 ? (
              collapsed ? null : (
                <div className="px-4 text-xs text-muted-foreground">
                  {t('bots.options.allHidden', 'All bots are paused and hidden.')}
                </div>
              )
            ) : treeRows.length === 0 ? (
              collapsed ? null : (
                <SidebarBotsEmptyState onNewBot={openNewBot} />
              )
            ) : collapsed ? null : (
              <>
                <BotSidebarVirtualRows
                  entries={treeRows}
                  listRef={listRef}
                  draggingId={drag.state.draggingGroupId}
                  revealId={pendingRenameKey ?? reveal.request?.target.entryKey}
                  renderEntry={(row) => {
                    const entryDrag: BotSidebarEntryDrag | undefined =
                      draggable && row.kind === 'entry'
                        ? {
                            bucket: getProjectGroupHeaderDragBucketKey({
                              parentGroupId: row.parentId
                            }),
                            index: row.bucketIndex,
                            dragging: drag.state.draggingGroupId === row.id,
                            settling: drag.state.draggingGroupId !== null,
                            offset: drag.state.previewOffsetsById?.get(row.id) ?? 0,
                            onPointerDown: (event) => drag.onHandlePointerDown(event, row.id)
                          }
                        : undefined
                    return (
                      <BotSidebarTreeEntry
                        row={row}
                        drag={entryDrag}
                        onOpen={onOpenBot}
                        onFolderAction={setFolderDialog}
                        onToggleFolder={(id) =>
                          toggleCollapsedGroup(getBotSidebarFolderGroupKey(id))
                        }
                        onToggleGroup={(id) => toggleCollapsedGroup(getBotSidebarGroupFoldKey(id))}
                        onCreateSubgroup={
                          bots.length >= 2
                            ? (parentKey) => setEditingGroup({ parentKey })
                            : undefined
                        }
                        onManageMembers={setEditingGroup}
                        onMoveGroup={setMovingGroup}
                        onDeleteGroup={(group) => void deleteGroup(group)}
                        membersByGroup={membersByGroup}
                        activeGroupId={activeGroupId}
                        activeWorkspaceId={activeWorkspaceId}
                        pendingRenameKey={pendingRenameKey}
                        onRenameConsumed={(id) =>
                          setPendingRenameKey((current) => (current === id ? null : current))
                        }
                        hasFolders={hasFolders}
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
      {folderDialog ? (
        <BotFolderDialogs state={folderDialog} onClose={() => setFolderDialog(null)} />
      ) : null}
      {movingGroup ? (
        <BotGroupMoveDialog
          group={movingGroup}
          groups={groups}
          onClose={() => setMovingGroup(null)}
        />
      ) : null}
      {editingGroup ? (
        <LazyBotGroupMembersDialog
          group={'parentKey' in editingGroup ? undefined : editingGroup}
          subgroup={
            subgroupParent && {
              parentName: subgroupParent.name,
              onCreated: (group) =>
                moveBotGroupInSidebar(botSidebarEntryKey(group), botSidebarEntryKey(subgroupParent))
            }
          }
          onClose={() => setEditingGroup(null)}
        />
      ) : null}
    </div>
  )
}
