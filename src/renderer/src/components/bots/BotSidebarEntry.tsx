import React, { useEffect, useLayoutEffect, useMemo } from 'react'
import { ChevronDown, GitBranch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AttachedWorktreeCards } from '@/components/sidebar/AttachedWorktreeCards'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import { selectDrawsNewWorktreeCards } from '@/store/appearance/worktree-card-style'
import type { Bot } from '../../../../shared/bot-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { isActiveSidebarWorkspace } from '../../../../shared/sidebar-list/selection/active-workspace'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { getLineageGroupKey } from '../../../../shared/sidebar-list/sections/group-keys'
import {
  folderWorkspaceKey,
  getActiveSidebarWorkspaceId
} from '../../../../shared/workspace/identity/workspace-scope'
import {
  BOT_ACTIVE_WORKSPACE_LINE_LIMIT,
  capBotWorkspaceLines,
  countLiveBotWorkspaces
} from '../../../../shared/bots/bot-sidebar-workspaces'
import { ROOT_PROJECT_GROUP_HEADER_BUCKET } from '@/components/sidebar/worktree-list/drag/project-group-header-drop'
import { BotRow } from './BotRow'
import { BotSidebarChats } from './BotSidebarChats'
import { botListsUnderRow } from '../../../../shared/bots/bot-sidebar-tree'
import { useBotOwnChatTree } from './use-bot-chat-tree'
import { botSidebarEntryKey } from './bot-sidebar-entry-keys'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { useBotWorkspaceOrder } from './use-bot-workspace-order'
import { selectIsSleepingWorktree } from '@/components/sidebar/workspace-actions/sleep/use-worktree-sleep-state'
import { useBotWorkerWorkspaces, useLiveWorkspaceStatuses } from './use-bot-worker-statuses'
import { observeBotActiveLine } from './bot-auto-unfold-memory'
import { setBotSidebarChildren } from './bot-sidebar-child-presence'
import { useBotSidebarPaging } from './bot-sidebar-paging'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { useBotsRevealSettle } from './bots-sidebar-reveal-context'
import {
  collectVisibleBotWorkerWorktrees,
  setBotSidebarCycleWorkers
} from './bot-sidebar-cycle-entries'

// The bot row's status lane and gap, so a line's status glyph lands under the bot's avatar.
export const BOT_WORKSPACE_LINE_INDENT = 19
// The new card style's wider lane; the line itself is always a Compact card.
const BOT_WORKSPACE_LINE_INDENT_NEW_CARD_STYLE = 27

/** A bot's row with the workspaces its workers made, one Compact line each under the bot's avatar. */
/** The Bots section's reorder, which measures each entry, workspaces included, by these attributes. */
export type BotSidebarEntryDrag = {
  index: number
  dragging: boolean
  /** Some bot is dragging, so rows slide to their drop offsets. */
  settling: boolean
  /** How far this row slides to open the drop gap. */
  offset: number
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
}

export function BotSidebarEntry({
  bot,
  home,
  isActive,
  onOpen,
  drag
}: {
  bot: Bot
  home: FolderWorkspace
  isActive: boolean
  onOpen: () => void
  drag?: BotSidebarEntryDrag
}): React.JSX.Element {
  // A disconnected server's row keeps its place in a drag but can't start one: nothing can save it.
  const offline = useBotHostOffline(bot.hostId)
  const frameDrag = drag && offline ? { ...drag, onPointerDown: ignorePointerDown } : drag
  const groupKey = getLineageGroupKey(folderWorkspaceKey(home.id))
  const folded = useAppStore((s) => s.collapsedGroups.has(groupKey))
  const toggleCollapsedGroup = useAppStore((s) => s.toggleCollapsedGroup)
  const newCardStyle = useAppStore(selectDrawsNewWorktreeCards)
  // Full-page Tasks/Activity views have no open workspace line, as in AttachedWorktreeCards.
  const activeWorktreeId = useAppStore((s) =>
    s.activeView === 'tasks' || s.activeView === 'activity'
      ? null
      : getActiveSidebarWorkspaceId(s.activeWorkspaceKey, s.activeWorktreeId)
  )
  const activeHostId = useAppStore((s) => s.activeWorkspaceExecutionHostId ?? null)
  const { childWorktrees, lineageChildrenByParentIdentity } = useBotWorkerWorkspaces(home)
  const ordered = useBotWorkspaceOrder(childWorktrees)
  // The open workspace's line, or the line it is nested under, so that line stays listed too.
  const activeLine = useMemo(() => {
    const active = { worktreeId: activeWorktreeId, hostId: activeHostId }
    return activeWorktreeId
      ? ordered.find(
          (worktree) =>
            isActiveSidebarWorkspace(worktree, active) ||
            lineHoldsActive(worktree, lineageChildrenByParentIdentity, active)
        )
      : undefined
  }, [ordered, lineageChildrenByParentIdentity, activeWorktreeId, activeHostId])
  const hideSleeping = useAppStore((s) => s.botSidebarView.hideSleepingWorkers)
  // Joined ids keep the selector's result stable between unrelated store writes.
  const sleepingIds = useAppStore((s) =>
    hideSleeping
      ? ordered
          .filter((worktree) => worktree !== activeLine && selectIsSleepingWorktree(s, worktree.id))
          .map((worktree) => worktree.id)
          .join('\n')
      : ''
  )
  const workspaces = useMemo(() => {
    if (!sleepingIds) {
      return ordered
    }
    const sleeping = new Set(sleepingIds.split('\n'))
    return ordered.filter((worktree) => !sleeping.has(worktree.id))
  }, [ordered, sleepingIds])
  const workspaceIds = useMemo(() => workspaces.map((worktree) => worktree.id), [workspaces])
  const entryKey = botSidebarEntryKey(bot)
  useEffect(() => {
    setBotSidebarChildren(entryKey, { workspaces: workspaces.length > 0, available: !offline })
  }, [entryKey, workspaces.length, offline])
  const statuses = useLiveWorkspaceStatuses(workspaceIds)
  const activeLineId = activeLine?.id ?? null
  // Its project lists the line too while Hide bot workspaces is off, so only unfold when the bot is its sole listing.
  const listedOnlyHere = useAppStore((s) => s.hideBotCreatedWorkspaces !== false)
  useEffect(() => {
    // Only on a change it sees: mounting again unchanged keeps a fold the owner chose (Collapse all bots).
    const changed = observeBotActiveLine(groupKey, activeLineId, listedOnlyHere)
    if (
      changed &&
      listedOnlyHere &&
      activeLineId &&
      useAppStore.getState().collapsedGroups.has(groupKey)
    ) {
      toggleCollapsedGroup(groupKey)
    }
  }, [activeLineId, groupKey, listedOnlyHere, toggleCollapsedGroup])
  const listsUnderRow = botListsUnderRow({ folded, hostDown: offline })
  useLayoutEffect(() => {
    if (!listsUnderRow) {
      setBotSidebarCycleWorkers(entryKey, [])
    }
  }, [entryKey, listsUnderRow])
  return (
    <BotSidebarDragFrame id={botSidebarEntryKey(bot)} drag={frameDrag}>
      <BotRow
        bot={bot}
        home={home}
        isActive={isActive}
        onOpen={onOpen}
        dragHandle={drag !== undefined && !offline}
        // A down host's bot is its row alone, so it has nothing to fold.
        fold={
          offline
            ? null
            : {
                folded,
                total: workspaces.length,
                counts: countLiveBotWorkspaces(statuses),
                onToggle: () => toggleCollapsedGroup(groupKey)
              }
        }
      />
      {/* Folded, the bot reads nothing from its host. */}
      {!listsUnderRow ? null : (
        <div
          className={cn(
            // Nested workspace rows' spacing, so a selected row's highlight clears its neighbours.
            'flex flex-col gap-1 transition-opacity duration-200',
            bot.paused && 'opacity-60'
          )}
          style={{
            marginLeft: newCardStyle
              ? BOT_WORKSPACE_LINE_INDENT_NEW_CARD_STYLE
              : BOT_WORKSPACE_LINE_INDENT
          }}
        >
          <BotSidebarList
            bot={bot}
            workspaces={workspaces}
            lineageChildrenByParentIdentity={lineageChildrenByParentIdentity}
            activeLine={activeLine}
            onFoldBot={() => toggleCollapsedGroup(groupKey)}
            onOpen={onOpen}
          />
        </div>
      )}
    </BotSidebarDragFrame>
  )
}

/** An unfolded bot's chats with their workspaces; with no chats read, its workspaces flat.
 *  Nothing until the first read lands, so the workers never flash unfolded before their folded chats. */
function BotSidebarList({
  bot,
  workspaces,
  lineageChildrenByParentIdentity,
  activeLine,
  onFoldBot,
  onOpen
}: {
  bot: Bot
  workspaces: Worktree[]
  lineageChildrenByParentIdentity: ReadonlyMap<string, Worktree[]>
  activeLine: Worktree | undefined
  onFoldBot: () => void
  onOpen: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const chatTree = useBotOwnChatTree(bot)
  const entryKey = botSidebarEntryKey(bot)
  useEffect(() => {
    if (chatTree.state === 'ready') {
      setBotSidebarChildren(entryKey, { chats: chatTree.chats.length > 0 })
    }
  }, [entryKey, chatTree.state, chatTree.chats.length])
  const { showAllWorkspaces, toggleWorkspaces, chatSteps, setChatSteps } =
    useBotSidebarPaging(entryKey)
  const collapsedGroups = useAppStore((s) => s.collapsedGroups)
  // Once the host answers (or can't), the rows a reveal waits for are as listed as they will get.
  useBotsRevealSettle(entryKey, chatTree.state !== 'loading')
  const shown = useMemo(
    () =>
      chatTree.state === 'loading' || chatTree.chats.length > 0 || workspaces.length === 0
        ? []
        : showAllWorkspaces
          ? workspaces
          : capBotWorkspaceLines(workspaces, activeLine),
    [chatTree.state, chatTree.chats.length, workspaces, showAllWorkspaces, activeLine]
  )
  useLayoutEffect(() => {
    if (chatTree.state === 'loading') {
      setBotSidebarCycleWorkers(entryKey, [])
      return
    }
    if (chatTree.chats.length > 0) {
      return
    }
    setBotSidebarCycleWorkers(
      entryKey,
      collectVisibleBotWorkerWorktrees(shown, lineageChildrenByParentIdentity, collapsedGroups)
    )
  }, [
    entryKey,
    chatTree.state,
    chatTree.chats.length,
    shown,
    lineageChildrenByParentIdentity,
    collapsedGroups
  ])
  if (chatTree.state === 'loading') {
    return null
  }
  if (chatTree.chats.length > 0) {
    return (
      <BotSidebarChats
        bot={bot}
        tree={chatTree}
        workspaces={workspaces}
        lineageChildrenByParentIdentity={lineageChildrenByParentIdentity}
        activeLine={activeLine}
        steps={chatSteps}
        onStep={setChatSteps}
        onOpen={onOpen}
      />
    )
  }
  if (workspaces.length === 0) {
    return null
  }
  const hidden = workspaces.length - shown.length
  return (
    <>
      {/* Names the lines as workspaces, so they don't read as the bot's chat threads; clicking folds them. */}
      <button
        type="button"
        className="flex min-w-0 cursor-pointer items-center gap-1 self-start rounded-sm pt-0.5 pb-px pl-1 text-2xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-expanded
        onClick={onFoldBot}
      >
        <GitBranch className="size-2.5 shrink-0" />
        <span className="truncate">
          {t('bots.workspaces.heading', 'Workspaces · {{total}}', {
            total: workspaces.length
          })}
        </span>
        <ChevronDown className="size-2.5 shrink-0" />
      </button>
      <AttachedWorktreeCards
        roots={shown}
        lineageChildrenByParentIdentity={lineageChildrenByParentIdentity}
        compactLine
        lineOwnerHostId={bot.hostId}
        onOpen={onOpen}
      />
      {workspaces.length > BOT_ACTIVE_WORKSPACE_LINE_LIMIT ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ml-1 self-start"
          onClick={toggleWorkspaces}
        >
          <span className="text-muted-foreground">
            {showAllWorkspaces
              ? t('bots.workspaces.showFewer', 'Show fewer')
              : t('bots.workspaces.showMore', 'Show {{count}} more', {
                  count: hidden
                })}
          </span>
        </Button>
      ) : null}
    </>
  )
}

function ignorePointerDown(): void {}

/** Whether the open workspace is nested anywhere under `line`. */
function lineHoldsActive(
  line: Worktree,
  childrenByParent: ReadonlyMap<string, Worktree[]>,
  active: { worktreeId: string | null; hostId: ExecutionHostId | null }
): boolean {
  const seen = new Set<string>()
  const queue = [...(childrenByParent.get(getWorktreeHostIdentity(line)) ?? [])]
  for (let index = 0; index < queue.length; index += 1) {
    const child = queue[index]!
    const identity = getWorktreeHostIdentity(child)
    if (seen.has(identity)) {
      continue
    }
    seen.add(identity)
    if (isActiveSidebarWorkspace(child, active)) {
      return true
    }
    queue.push(...(childrenByParent.get(identity) ?? []))
  }
  return false
}

/** One entry of the Bots section's reorder, a bot's or a group's; the drag measures this frame. */
export function BotSidebarDragFrame({
  id,
  drag,
  children
}: {
  id: string
  drag: BotSidebarEntryDrag | undefined
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col',
        // The floating copy is the affordance, as for a dragged workspace row.
        drag?.dragging && 'pointer-events-none opacity-0'
      )}
      data-bot-sidebar-entry={id}
      data-project-group-header-id={drag ? id : undefined}
      data-project-group-header-index={drag?.index}
      data-project-group-header-bucket={drag ? ROOT_PROJECT_GROUP_HEADER_BUCKET : undefined}
      onPointerDown={drag?.onPointerDown}
    >
      {/* Only the content slides, so the drag keeps measuring the frame where it stands. */}
      <div
        className={cn(
          'flex flex-col',
          drag?.settling && 'transition-transform duration-150 ease-out will-change-transform'
        )}
        style={drag?.offset ? { transform: `translateY(${drag.offset}px)` } : undefined}
      >
        {children}
      </div>
    </div>
  )
}
