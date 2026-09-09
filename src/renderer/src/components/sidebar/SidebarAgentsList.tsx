import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { hasActivityThreadWorkspace } from '@/components/activity/activity-thread-actions'
import { useActivityThreadActionBindings } from '@/components/activity/use-activity-thread-action-bindings'
import { ActivityThreadListPane } from '@/components/activity/activity-thread-list-pane'
import { useAgentPaneThreads } from '@/components/activity/use-agent-pane-threads'
import { ActivityThreadOptionsMenu } from '@/components/activity/activity-thread-controls'
import type { ActivityGroupBy, ThreadReadFilter } from '@/components/activity/activity-thread-types'

/**
 * The Activity thread list, hosted in the sidebar as a navigator: selecting a
 * row reveals that agent's pane in the workbench instead of swapping the view.
 * Threads whose pane is gone stay listed but inert — activateThreadTerminal
 * already no-ops without a live tab.
 */
export type SidebarAgentsListProps = {
  readFilter: ThreadReadFilter
  setReadFilter: (filter: ThreadReadFilter) => void
  groupBy: ActivityGroupBy
  setGroupBy: (groupBy: ActivityGroupBy) => void
  query: string
  setQuery: (query: string) => void
  optionsTarget?: HTMLElement | null
  scrollTopRef?: React.MutableRefObject<number>
}

export default function SidebarAgentsList({
  readFilter,
  setReadFilter,
  groupBy,
  setGroupBy,
  query,
  setQuery,
  optionsTarget,
  scrollTopRef
}: SidebarAgentsListProps): React.JSX.Element {
  // The search row is owned here and mounts conditionally, so subscribe this host to locale changes.
  useTranslation()
  const compactMode = useAppStore((s) => s.agentsCompactMode)
  const setCompactMode = useAppStore((s) => s.setAgentsCompactMode)
  const showSearch = useAppStore((s) => s.agentsShowSearch)
  const setShowSearch = useAppStore((s) => s.setAgentsShowSearch)
  const showChildAgents = useAppStore((s) => s.agentsShowChildAgents)
  const setShowChildAgents = useAppStore((s) => s.setAgentsShowChildAgents)
  const [selectedPaneKey, setSelectedPaneKey] = useState<string | null>(null)
  const activityFilterInputRef = useRef<HTMLInputElement | null>(null)

  const handleShowSearchChange = useCallback(
    (visible: boolean) => {
      setShowSearch(visible)
      if (!visible) {
        setQuery('')
        return
      }
      // Wait for the newly visible input to mount before focusing it.
      requestAnimationFrame(() => activityFilterInputRef.current?.focus())
    },
    [setQuery, setShowSearch]
  )

  const {
    storeData,
    selectedPaneKeyIsLive,
    effectiveSelectedPaneKey,
    visibleThreads,
    markAllReadThreads,
    visibleThreadGroups
  } = useAgentPaneThreads({ query, readFilter, groupBy, selectedPaneKey, showChildAgents })

  useEffect(() => {
    if (!selectedPaneKeyIsLive) {
      setSelectedPaneKey(null)
    }
  }, [selectedPaneKeyIsLive])

  const {
    markThreadRead,
    markThreadUnread,
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

  const canJumpToWorkspace = useCallback(
    (thread: Parameters<typeof hasActivityThreadWorkspace>[0]) =>
      hasActivityThreadWorkspace(thread, {
        worktreesByRepo: storeData.worktreesByRepo,
        detectedWorktreesByRepo: storeData.detectedWorktreesByRepo,
        folderWorkspaces: storeData.folderWorkspaces,
        defaultHostId: storeData.defaultHostId
      }),
    [
      storeData.worktreesByRepo,
      storeData.detectedWorktreesByRepo,
      storeData.folderWorkspaces,
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
            placeholder={translate(
              'auto.components.activity.ActivityPrototypePage.795cbf26e2',
              'Filter...'
            )}
            className="h-7 w-full text-[11px] shadow-none focus-visible:ring-0"
            aria-label={translate(
              'auto.components.activity.ActivityPrototypePage.search',
              'Search'
            )}
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
              onToggleUnread={() => setReadFilter(readFilter === 'unread' ? 'all' : 'unread')}
            />,
            optionsTarget
          )
        : null}
    </div>
  )
}
