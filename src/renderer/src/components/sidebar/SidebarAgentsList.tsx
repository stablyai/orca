import React, { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { SidebarActivityBadge } from './sidebar-activity-badge'
import { activityThreadStatusId } from '@/components/activity/activity-thread-presentation'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { hasActivityThreadWorkspace } from '@/components/activity/activity-thread-actions'
import { useActivityThreadActionBindings } from '@/components/activity/use-activity-thread-action-bindings'
import { ActivityThreadListPane } from '@/components/activity/activity-thread-list-pane'
import { useAgentPaneThreads } from '@/components/activity/use-agent-pane-threads'
import { ActivityThreadOptionsMenu } from '@/components/activity/activity-thread-controls'
import type {
  ActivityGroupBy,
  ThreadReadFilter
} from '../../../../shared/agents-view-thread-filters'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

/** Select threads by revealing their existing panes; threads whose panes are gone remain listed but inert. */
export type SidebarAgentsListProps = {
  active?: boolean
  readFilter: ThreadReadFilter
  setReadFilter: (filter: ThreadReadFilter) => void
  groupBy: ActivityGroupBy
  setGroupBy: (groupBy: ActivityGroupBy) => void
  query: string
  setQuery: (query: string) => void
  badgeTarget?: HTMLElement | null
  optionsTarget?: HTMLElement | null
  scrollTopRef?: React.MutableRefObject<number>
}

export default function SidebarAgentsList({
  active = true,
  badgeTarget,
  ...listProps
}: SidebarAgentsListProps): React.JSX.Element | null {
  useTranslation()
  const showChildAgents = useAppStore((s) => s.agentsShowChildAgents)
  const [selectedPaneKey, setSelectedPaneKey] = useState<string | null>(null)

  const threads = useAgentPaneThreads({
    query: listProps.query,
    readFilter: listProps.readFilter,
    groupBy: listProps.groupBy,
    selectedPaneKey,
    showChildAgents,
    badgeOnly: !active
  })
  const { selectedPaneKeyIsLive, visibleThreads } = threads

  if ((!active && selectedPaneKey !== null) || !selectedPaneKeyIsLive) {
    // Reset selection when leaving Activity or when its pane vanishes.
    setSelectedPaneKey(null)
  }

  const counts = { attention: 0, working: 0 }
  for (const thread of visibleThreads) {
    if (!thread.currentAgentState) {
      continue
    }
    const status = activityThreadStatusId(thread)
    if (status === 'waiting' || status === 'blocked') {
      counts.attention += 1
    } else if (status === 'working' || status === 'monitoring') {
      counts.working += 1
    }
  }

  const badge = badgeTarget
    ? createPortal(<SidebarActivityBadge counts={counts} />, badgeTarget)
    : null
  if (!active) {
    return badge
  }

  return (
    <>
      {badge}
      <SidebarAgentsListBody
        {...listProps}
        threads={threads}
        setSelectedPaneKey={setSelectedPaneKey}
      />
    </>
  )
}

function SidebarAgentsListBody({
  readFilter,
  setReadFilter,
  groupBy,
  setGroupBy,
  query,
  setQuery,
  optionsTarget,
  scrollTopRef,
  threads,
  setSelectedPaneKey
}: Omit<SidebarAgentsListProps, 'active' | 'badgeTarget'> & {
  threads: ReturnType<typeof useAgentPaneThreads>
  setSelectedPaneKey: (paneKey: string | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  // Subscribe here because the translated search row mounts conditionally.
  useTranslation()
  const compactMode = useAppStore((s) => s.agentsCompactMode)
  const setCompactMode = useAppStore((s) => s.setAgentsCompactMode)
  const showSearch = useAppStore((s) => s.agentsShowSearch)
  const setShowSearch = useAppStore((s) => s.setAgentsShowSearch)
  const showChildAgents = useAppStore((s) => s.agentsShowChildAgents)
  const setShowChildAgents = useAppStore((s) => s.setAgentsShowChildAgents)
  const activityFilterInputRef = useRef<HTMLInputElement | null>(null)

  const handleShowSearchChange = useCallback(
    (visible: boolean) => {
      setShowSearch(visible)
      if (!visible) {
        setQuery('')
        return
      }
      // Focus after the newly visible input mounts.
      requestAnimationFrame(() => activityFilterInputRef.current?.focus())
    },
    [setQuery, setShowSearch]
  )

  const {
    storeData,
    effectiveSelectedPaneKey,
    visibleThreads,
    markAllReadThreads,
    visibleThreadGroups
  } = threads

  const {
    markThreadRead,
    markThreadUnread,
    markThreadsRead,
    markThreadsUnread,
    selectThread,
    jumpToWorkspace,
    markAllThreadsRead,
    hasUnreadThreads,
    hasCompletedThreads,
    handleClearCompleted
  } = useActivityThreadActionBindings({
    visibleThreads,
    markAllReadThreads,
    acknowledgeAgents: storeData.acknowledgeAgents,
    unacknowledgeAgents: storeData.unacknowledgeAgents,
    setSelectedPaneKey
  })

  const worktreesByRepo = selectWorktreesByRepo(storeData)
  const detectedWorktreesByRepo = selectDetectedWorktreesByRepo(storeData)
  const folderWorkspaces = selectFolderWorkspaces(storeData)

  const canJumpToWorkspace = useCallback(
    (thread: Parameters<typeof hasActivityThreadWorkspace>[0]) =>
      hasActivityThreadWorkspace(thread, {
        worktreesByRepo,
        detectedWorktreesByRepo,
        folderWorkspaces,
        floatingWorkspacePath: storeData.floatingWorkspacePath,
        defaultHostId: storeData.defaultHostId
      }),
    [
      worktreesByRepo,
      detectedWorktreesByRepo,
      folderWorkspaces,
      storeData.floatingWorkspacePath,
      storeData.defaultHostId
    ]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showSearch ? (
        <div className="shrink-0 border-b border-border px-2 py-1.5">
          <Input
            ref={activityFilterInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                handleShowSearchChange(false)
              }
            }}
            placeholder={t(
              'auto.components.activity.ActivityPrototypePage.795cbf26e2',
              'Filter...'
            )}
            className="h-7 w-full text-[11px] shadow-none focus-visible:ring-0"
            aria-label={t('auto.components.activity.ActivityPrototypePage.search', 'Search')}
          />
        </div>
      ) : null}
      <ActivityThreadListPane
        activityFilterInputRef={activityFilterInputRef}
        query={query}
        onQueryChange={setQuery}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        readFilter={readFilter}
        onReadFilterChange={setReadFilter}
        compactMode={compactMode}
        showChildAgents={showChildAgents}
        hasUnreadThreads={hasUnreadThreads}
        onCompactModeChange={setCompactMode}
        onShowChildAgentsChange={setShowChildAgents}
        onMarkAllThreadsRead={markAllThreadsRead}
        hasCompletedThreads={hasCompletedThreads}
        onClearCompleted={handleClearCompleted}
        visibleThreadGroups={visibleThreadGroups}
        visibleThreadCount={visibleThreads.length}
        selectedPaneKey={effectiveSelectedPaneKey}
        onSelectThread={selectThread}
        onJumpToWorkspace={jumpToWorkspace}
        onMarkThreadRead={markThreadRead}
        onMarkThreadUnread={markThreadUnread}
        onMarkThreadsRead={markThreadsRead}
        onMarkThreadsUnread={markThreadsUnread}
        canJumpToWorkspace={canJumpToWorkspace}
        allowMarkUnreadWhenSelected
        showJumpAction={false}
        showFilterControls={false}
        showOptionsMenu={false}
        showInlineActions={false}
        scrollTopRef={scrollTopRef}
      />
      {optionsTarget
        ? createPortal(
            <ActivityThreadOptionsMenu
              groupBy={groupBy}
              onGroupByChange={setGroupBy}
              compactMode={compactMode}
              showChildAgents={showChildAgents}
              hasUnreadThreads={hasUnreadThreads}
              hasCompletedThreads={hasCompletedThreads}
              onCompactModeChange={setCompactMode}
              onShowChildAgentsChange={setShowChildAgents}
              onMarkAllThreadsRead={markAllThreadsRead}
              onClearCompleted={handleClearCompleted}
              showSearch={showSearch}
              onShowSearchChange={handleShowSearchChange}
              unreadOnly={readFilter === 'unread'}
              onUnreadOnlyChange={(unreadOnly) => setReadFilter(unreadOnly ? 'unread' : 'all')}
            />,
            optionsTarget
          )
        : null}
    </div>
  )
}
