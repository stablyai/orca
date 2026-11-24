import React, { useMemo } from 'react'
import WorktreeCard from '@/components/sidebar/workspace-card/surface/WorktreeCard'
import { stopNestedWorktreeCardBubble } from '@/components/sidebar/worktree-list/rows/header-event-guards'
import {
  getLineageChildrenInlineStyle,
  LINEAGE_CHILDREN_INLINE_OFFSET
} from '@/components/sidebar/worktree-list/rows/indentation'
import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeCardLineWorker } from './workspace-card/controller/worktree-card-model'
import { isActiveSidebarWorkspace } from '../../../../shared/sidebar-list/selection/active-workspace'
import { getWorktreeLineageGroupKey } from '../../../../shared/sidebar-list/sections/group-keys'
import { getActiveSidebarWorkspaceId } from '../../../../shared/workspace/identity/workspace-scope'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { botWorkerLineRowKey } from '../../../../shared/sidebar-list/sidebar-reveal-target'
import { botLineLanes, lanesNeedingYouFirst } from '../../../../shared/bots/bot-line-lanes'
import { useWorktreeActivityStatuses } from './workspace-card/activity/use-worktree-activity-statuses'

/** Worktree cards attached to a folder workspace, each with its own child worktrees folded beneath it;
 *  a bot's line lists all of its descendants at one level, those waiting on the owner first. */
export function AttachedWorktreeCards({
  roots,
  lineageChildrenByParentIdentity,
  showProjectName = false,
  compactLine = false,
  lineOwnerHostId,
  affiliateListMode = false,
  lineNotes,
  lineWorkers,
  onOpen
}: {
  roots: readonly Worktree[]
  lineageChildrenByParentIdentity: ReadonlyMap<string, Worktree[]>
  /** Names the card's project, for a list that mixes projects. */
  showProjectName?: boolean
  /** One Compact line per card, as under a bot. */
  compactLine?: boolean
  /** The bot's computer, for lines under a bot: a line on another paired server names it. */
  lineOwnerHostId?: ExecutionHostId
  /** The flat card style of a panel, not the sidebar's. */
  affiliateListMode?: boolean
  /** A muted note after a line's name, by worktree id, as under a bot's chat. */
  lineNotes?: ReadonlyMap<string, string>
  /** The worker a line stands for, by worktree id: its dot and what a press opens. */
  lineWorkers?: ReadonlyMap<string, WorktreeCardLineWorker>
  /** Runs when a card is opened, as a sidebar card closes the workspace board. */
  onOpen?: () => void
}): React.JSX.Element {
  // Full-page Tasks/Activity views have no selected workspace card, as in the workspace list.
  const activeWorktreeId = useAppStore((s) =>
    s.activeView === 'tasks' || s.activeView === 'activity'
      ? null
      : getActiveSidebarWorkspaceId(s.activeWorkspaceKey, s.activeWorktreeId)
  )
  const activeHostId = useAppStore((s) => s.activeWorkspaceExecutionHostId ?? null)
  const repos = useAppStore((s) => s.repos)
  const collapsedGroups = useAppStore((s) => s.collapsedGroups)
  const toggleCollapsedGroup = useAppStore((s) => s.toggleCollapsedGroup)
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  const lanesByRoot = useMemo(
    () =>
      compactLine
        ? new Map(
            roots.map((root) => [
              root.id,
              botLineLanes(
                root,
                (line) => lineageChildrenByParentIdentity.get(getWorktreeHostIdentity(line)) ?? [],
                getWorktreeHostIdentity
              )
            ])
          )
        : null,
    [compactLine, roots, lineageChildrenByParentIdentity]
  )
  const laneIdsKey = lanesByRoot
    ? [...lanesByRoot.values()].flatMap((lanes) => lanes.map((lane) => lane.id)).join('\n')
    : ''
  const laneIds = useMemo(() => (laneIdsKey ? laneIdsKey.split('\n') : []), [laneIdsKey])
  const laneStatuses = useWorktreeActivityStatuses(laneIds)

  const renderCard = (
    worktree: Worktree,
    ancestorIdentities: ReadonlySet<string> = new Set(),
    lane = false
  ): React.JSX.Element => {
    const identity = getWorktreeHostIdentity(worktree)
    const nextAncestorIdentities = new Set([...ancestorIdentities, identity])
    const rootLanes = lanesByRoot?.get(worktree.id)
    const children = lane
      ? []
      : rootLanes
        ? lanesNeedingYouFirst(rootLanes, (line) => laneStatuses.get(line.id) === 'permission')
        : (lineageChildrenByParentIdentity.get(identity) ?? []).filter(
            (child) => !nextAncestorIdentities.has(getWorktreeHostIdentity(child))
          )
    const groupKey = getWorktreeLineageGroupKey(worktree)
    const collapsed = collapsedGroups.has(groupKey)
    const isActive = isActiveSidebarWorkspace(worktree, {
      worktreeId: activeWorktreeId,
      hostId: activeHostId
    })
    const card = (
      <WorktreeCard
        key={worktree.id}
        worktree={worktree}
        repo={repoById.get(worktree.repoId)}
        isActive={isActive}
        isActiveSurface={!affiliateListMode && isActive}
        onWorktreeCardClick={onOpen}
        hideRepoBadge={false}
        showProjectName={showProjectName}
        compactLine={compactLine}
        // A bot's line is its own rename target, apart from the same worktree's card elsewhere.
        renameRowKey={compactLine ? botWorkerLineRowKey(identity) : undefined}
        lineOwnerHostId={lineOwnerHostId}
        lineNote={lineNotes?.get(worktree.id)}
        lineWorker={lineWorkers?.get(worktree.id)}
        nativeDragEnabled={false}
        // A regular nested child row's geometry, so a selected row's glyph clears its border.
        flushSurface
        contentIndent={0}
        affiliateListMode={affiliateListMode}
        lineageChildCount={children.length}
        lineageChildWorktreeIds={rootLanes && !lane ? rootLanes.map((line) => line.id) : undefined}
        lineageCollapsed={collapsed}
        lineageChildren={
          !collapsed && children.length > 0
            ? children.map((child) => (
                <div
                  key={child.id}
                  onClick={stopNestedWorktreeCardBubble}
                  onDoubleClick={stopNestedWorktreeCardBubble}
                  onDragStart={stopNestedWorktreeCardBubble}
                >
                  {renderCard(child, nextAncestorIdentities, rootLanes !== undefined)}
                </div>
              ))
            : undefined
        }
        lineageChildrenStyle={
          children.length > 0
            ? getLineageChildrenInlineStyle(LINEAGE_CHILDREN_INLINE_OFFSET)
            : undefined
        }
        onLineageToggle={
          children.length > 0
            ? (event) => {
                event.preventDefault()
                event.stopPropagation()
                toggleCollapsedGroup(groupKey)
              }
            : undefined
        }
      />
    )
    // A bot's lines carry their identity, so "Reveal current" can find the open one; `contents`
    // leaves the list's layout as it was.
    return compactLine ? (
      <div key={worktree.id} className="contents" data-bot-sidebar-line={identity}>
        {card}
      </div>
    ) : (
      card
    )
  }

  return <>{roots.map((worktree) => renderCard(worktree))}</>
}
