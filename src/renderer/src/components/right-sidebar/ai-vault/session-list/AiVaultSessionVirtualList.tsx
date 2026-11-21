import { SubagentExpansionProvider } from './ai-vault-subagent-expansion'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react'
import type { AgentDotState } from '@/components/agent/status/AgentStateDot'
import type {
  AiVaultScope,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultResumeStartup } from '../../../../../../shared/ai-vault/resume/ai-vault-resume-startup'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { measureVirtualRowRetainingHiddenSize } from '@/lib/list-interaction/virtualized-hidden-row-measurement'
import { getActiveStickyHeaderIndexForScroll } from '../../../sidebar/worktree-list/viewport/virtual-rows'
import { EmptyState, SessionLoadingState } from './AiVaultSessionListStates'
import type { AiVaultSessionListGroup } from './ai-vault-session-filters'
import type { AiVaultOriginalPaneTarget } from '../session-actions/ai-vault-original-pane'
import type { AiVaultSessionProject } from '../../../../../../shared/ai-vault/session-display/ai-vault-session-filters'
import type {
  AiVaultSessionResumeActions,
  AiVaultSessionResumeState
} from '../session-actions/ai-vault-session-resume'
import type { AiVaultSessionWorktreeInfo } from '../../../../../../shared/ai-vault/session-display/ai-vault-session-worktree'
import {
  extractVaultVirtualRowIndexes,
  getVaultStickyHeaderIndexes,
  VAULT_GROUP_HEADER_ROW_HEIGHT,
  VAULT_SESSION_ROW_HEIGHT
} from './ai-vault-virtual-rows'
import type { AiVaultResumeInChatEligibility } from '../session-actions/ai-vault-session-resume-in-chat'
import { AiVaultVirtualRow, type AiVaultListRow } from './AiVaultVirtualRow'
import type { AiVaultSearchHit } from '../../../../../../shared/ai-vault/search/ai-vault-search-types'
import type { AiVaultSessionRowChatActions } from '../session-actions/ai-vault-session-chat-action'
import { aiVaultSessionRowChat } from '../session-actions/ai-vault-session-row-chat'
import {
  resumeAiVaultSessionHere,
  type AiVaultResumeHere
} from '../session-actions/ai-vault-session-resume-here'
import {
  useAiVaultSessionListKeyboard,
  useAiVaultSessionSelection,
  type AiVaultSessionListKeyboard
} from './use-ai-vault-session-keyboard-navigation'

const VAULT_ROW_OVERSCAN = 8
const VAULT_EXPANDED_SESSION_ROW_ESTIMATED_HEIGHT = 420

export function AiVaultSessionVirtualList({
  conversationNavigation = false,
  groups,
  collapsedGroups,
  loading,
  stale = false,
  resultsKey,
  scopePending = false,
  scanProgressShown = false,
  sessionsCount,
  filteredSessionsCount,
  noAgentsSelected,
  error,
  vaultScope,
  buildResumeStartup,
  getOriginalPaneTarget,
  isStructuredSessionOpen,
  getSessionLiveState,
  getWorktreeInfo,
  getSessionResumeState,
  getSessionResumeActions,
  getSessionResumeInChat,
  onToggleGroup,
  onJumpToOriginalPane,
  onJumpToWorktree,
  onResume,
  onContinueInNewSession,
  onResumeInNewChat,
  onResumeInNewCli,
  onCopyResume,
  onCopyId,
  onCopyPath,
  onOpenLog,
  onRevealLog,
  onOpenCwd,
  onRevealArtifacts,
  onRequestDelete,
  searchHits,
  searchHitHostLabels,
  keyboardRef,
  query = '',
  resumeHere
}: {
  sessionProjects?: ReadonlyMap<string, AiVaultSessionProject>
  conversationNavigation?: boolean
  groups: readonly AiVaultSessionListGroup[]
  collapsedGroups: ReadonlySet<string>
  loading: boolean
  /** Rows answer an older search while a newer one runs. */
  stale?: boolean
  /** Changes when a different result set lands, which returns the list to its top match. */
  resultsKey?: string
  scopePending?: boolean
  /** The progress strip above names the scan, so the list does not repeat it. */
  scanProgressShown?: boolean
  sessionsCount: number
  filteredSessionsCount: number
  noAgentsSelected: boolean
  error: string | null
  vaultScope: AiVaultScope
  buildResumeStartup: (session: AiVaultSession, worktreeId?: string | null) => AiVaultResumeStartup
  getOriginalPaneTarget: (session: AiVaultSession) => AiVaultOriginalPaneTarget | null
  isStructuredSessionOpen: (session: AiVaultSession) => boolean
  getSessionLiveState: (session: AiVaultSession) => AgentDotState | null
  getWorktreeInfo: (session: AiVaultSession) => AiVaultSessionWorktreeInfo | null
  getSessionResumeState: (session: AiVaultSession) => AiVaultSessionResumeState
  getSessionResumeActions: (session: AiVaultSession) => AiVaultSessionResumeActions
  getSessionResumeInChat: (session: AiVaultSession) => AiVaultResumeInChatEligibility
  onToggleGroup: (key: string) => void
  onJumpToOriginalPane: (session: AiVaultSession) => void
  onJumpToWorktree: (worktreeId: string) => void
  onResume: (session: AiVaultSession, worktreeId: string) => void
  onContinueInNewSession: (session: AiVaultSession, worktreeId: string) => void
  onResumeInNewChat: (session: AiVaultSession, worktreeId: string) => void
  onResumeInNewCli: (session: AiVaultSession, worktreeId: string) => void
  onCopyResume: (session: AiVaultSession, worktreeId?: string | null) => void
  onCopyId: (session: AiVaultSession) => void
  onCopyPath: (session: AiVaultSession) => void
  onOpenLog: (session: AiVaultSession) => void
  onRevealLog: (session: AiVaultSession) => void
  onOpenCwd: (session: AiVaultSession) => void
  onRevealArtifacts: (session: AiVaultSession) => void
  onRequestDelete: (session: AiVaultSession) => void
  searchHits?: ReadonlyMap<string, AiVaultSearchHit>
  /** Set only when search hits span several hosts. */
  searchHitHostLabels?: ReadonlyMap<string, string> | null
  /** Present only where rows are keyboard-selectable. */
  keyboardRef?: Ref<AiVaultSessionListKeyboard>
  /** The search text; editing it moves the keyboard selection back to the top match. */
  query?: string
  /** Set in `/resume`: picking a row resumes it in that chat, and rows offer no other action. */
  resumeHere?: AiVaultResumeHere
}): React.JSX.Element {
  const t = useTranslate()
  const listScrollRef = useRef<HTMLDivElement>(null)
  const stickyRangeStartIndexRef = useRef(0)
  const activeStickyHeaderIndexRef = useRef<number | null>(null)
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(() => new Set())
  useLayoutEffect(() => {
    listScrollRef.current?.scrollTo({ top: 0 })
  }, [resultsKey])

  const vaultRows = useMemo(() => {
    const rows: AiVaultListRow[] = []
    for (const sessionGroup of groups) {
      const label = sessionGroup.label
      if (label !== null) {
        rows.push({ type: 'group', group: { ...sessionGroup, label } })
      }
      if (label === null || !collapsedGroups.has(sessionGroup.key)) {
        for (const session of sessionGroup.sessions) {
          rows.push({ type: 'session', groupKey: sessionGroup.key, session })
        }
      }
    }
    return rows
  }, [collapsedGroups, groups])

  const stickyHeaderIndexes = useMemo(() => getVaultStickyHeaderIndexes(vaultRows), [vaultRows])
  const selection = useAiVaultSessionSelection(
    vaultRows,
    keyboardRef !== undefined,
    JSON.stringify([query, resultsKey ?? null])
  )
  const { selectedIndex } = selection

  const virtualizer = useVirtualizer({
    count: vaultRows.length,
    getScrollElement: () => listScrollRef.current,
    measureElement: measureVirtualRowRetainingHiddenSize,
    estimateSize: (index) => {
      const row = vaultRows[index]
      if (row?.type === 'group') {
        return VAULT_GROUP_HEADER_ROW_HEIGHT
      }
      if (row?.type === 'session' && expandedSessionIds.has(row.session.id)) {
        return VAULT_EXPANDED_SESSION_ROW_ESTIMATED_HEIGHT
      }
      return conversationNavigation ? 40 : VAULT_SESSION_ROW_HEIGHT
    },
    overscan: VAULT_ROW_OVERSCAN,
    // Why: the pinned group header covers the list's top, so a row scrolled into view stops below it.
    scrollPaddingStart: stickyHeaderIndexes.length > 0 ? VAULT_GROUP_HEADER_ROW_HEIGHT : 0,
    // Keep the active group header mounted so CSS sticky survives row virtualization.
    rangeExtractor: useCallback(
      (range) => {
        stickyRangeStartIndexRef.current = range.startIndex
        return extractVaultVirtualRowIndexes({ range, stickyHeaderIndexes })
      },
      [stickyHeaderIndexes]
    ),
    // A new key function makes the virtualizer re-measure every row, so keep it until the rows change.
    getItemKey: useCallback(
      (index: number) => {
        const row = vaultRows[index]
        if (!row) {
          return `missing:${index}`
        }
        return row.type === 'group' ? `group:${row.group.key}` : `session:${row.session.id}`
      },
      [vaultRows]
    )
  })

  const toggleSessionDetails = useCallback((sessionId: string) => {
    setExpandedSessionIds((current) => {
      const next = new Set(current)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }, [])

  const { rowActions, openConversation } = aiVaultSessionRowChat({
    getOriginalPaneTarget,
    isStructuredSessionOpen,
    getSessionResumeState,
    getSessionResumeInChat,
    searchHits,
    onResume,
    onJumpToOriginalPane,
    onResumeInNewChat
  })
  // Keep a synchronous single-flight latch while resume opens its destination so repeated picks cannot start duplicate resumes.
  const pickInFlight = useRef(false)
  const pickHere = (session: AiVaultSession): boolean => {
    if (!resumeHere) {
      return false
    }
    if (pickInFlight.current) {
      return true
    }
    const actions = rowActions(session)
    if (resumeHere.alongside) {
      return pickAlongside(session, actions, resumeHere)
    }
    const picked = resumeAiVaultSessionHere({
      session,
      here: resumeHere,
      actions,
      jump: onJumpToOriginalPane
    })
    if (!picked) {
      return false
    }
    pickInFlight.current = true
    const release = (): void => {
      pickInFlight.current = false
    }
    void picked.then(release, release)
    return true
  }
  // The row's own Resume and Resume in New Chat, so their eligibility and ownership checks hold.
  const pickAlongside = (
    session: AiVaultSession,
    actions: AiVaultSessionRowChatActions,
    here: AiVaultResumeHere
  ): boolean => {
    if (actions.canJumpToOriginalPane) {
      onJumpToOriginalPane(session)
    } else if (session.structuredSession && actions.resumeWorktreeId) {
      onResume(session, actions.resumeWorktreeId)
    } else if (actions.resumeInNewChatWorkspaceId) {
      onResumeInNewChat(session, actions.resumeInNewChatWorkspaceId)
    } else {
      return false
    }
    here.dismiss()
    return true
  }

  // Enter resumes the row in the chat; a row that can't shows its details instead.
  const activateSession = (session: AiVaultSession, index: number): void => {
    if (stale || (conversationNavigation && openConversation(session))) {
      return
    }
    if (!pickHere(session)) {
      setExpandedSessionIds((current) => new Set(current).add(session.id))
      virtualizer.scrollToIndex(index)
    }
  }
  const selectRow = useLatestHandler(selection.select)
  const pickSession = useLatestHandler((session: AiVaultSession) => {
    if (!pickHere(session)) {
      toggleSessionDetails(session.id)
    }
  })
  const openConversationRow = useLatestHandler((session: AiVaultSession) => {
    if (!openConversation(session)) {
      toggleSessionDetails(session.id)
    }
  })
  useAiVaultSessionListKeyboard(keyboardRef, {
    rows: vaultRows,
    selection,
    scrollToIndex: (index) => virtualizer.scrollToIndex(index),
    activate: activateSession
  })

  const virtualItems = virtualizer.getVirtualItems()
  activeStickyHeaderIndexRef.current = getActiveStickyHeaderIndexForScroll({
    rangeStartIndex: stickyRangeStartIndexRef.current,
    scrollOffset: virtualizer.scrollOffset ?? 0,
    stickyHeaderIndexes,
    virtualItems
  })

  return (
    <SubagentExpansionProvider>
      <div
        ref={listScrollRef}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-sleek"
      >
        {(loading && sessionsCount === 0) ||
        (scopePending && filteredSessionsCount === 0 && !noAgentsSelected) ? (
          <SessionLoadingState showLabel={!scanProgressShown} />
        ) : null}

        {!loading && sessionsCount === 0 && !error ? (
          <EmptyState
            title={t(
              'auto.components.right.sidebar.AiVaultPanel.noAgentSessionsFound',
              'No agent sessions found'
            )}
          />
        ) : null}

        {sessionsCount > 0 && filteredSessionsCount === 0 && (!scopePending || noAgentsSelected) ? (
          <EmptyState
            title={
              noAgentsSelected
                ? t(
                    'auto.components.right.sidebar.AiVaultPanel.noAgentsSelected',
                    'No agents selected'
                  )
                : t(
                    'auto.components.right.sidebar.AiVaultPanel.noSessionsMatchFilters',
                    'No sessions match the current filters'
                  )
            }
          />
        ) : null}

        {vaultRows.length > 0 ? (
          <div
            className={cn('relative w-full', stale && 'opacity-60')}
            aria-busy={stale || undefined}
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualItems.map((virtualRow) => {
              const row = vaultRows[virtualRow.index]
              return (
                <AiVaultVirtualRow
                  conversationNavigation={conversationNavigation}
                  onOpenConversation={conversationNavigation ? openConversationRow : undefined}
                  key={virtualRow.key}
                  row={row}
                  index={virtualRow.index}
                  start={virtualRow.start}
                  activeStickyHeader={
                    row?.type === 'group' && virtualRow.index === activeStickyHeaderIndexRef.current
                  }
                  measureElement={virtualizer.measureElement}
                  groupCollapsed={row?.type === 'group' && collapsedGroups.has(row.group.key)}
                  detailsExpanded={
                    row?.type === 'session' && expandedSessionIds.has(row.session.id)
                  }
                  vaultScope={vaultScope}
                  searchHit={row?.type === 'session' ? searchHits?.get(row.session.id) : undefined}
                  sourceHostLabel={
                    row?.type === 'session'
                      ? searchHitHostLabels?.get(row.session.executionHostId)
                      : undefined
                  }
                  buildResumeStartup={buildResumeStartup}
                  getOriginalPaneTarget={getOriginalPaneTarget}
                  isStructuredSessionOpen={isStructuredSessionOpen}
                  getSessionLiveState={getSessionLiveState}
                  getWorktreeInfo={getWorktreeInfo}
                  getSessionResumeState={getSessionResumeState}
                  getSessionResumeActions={getSessionResumeActions}
                  getSessionResumeInChat={getSessionResumeInChat}
                  onToggleGroup={onToggleGroup}
                  onToggleSessionDetails={toggleSessionDetails}
                  onJumpToOriginalPane={onJumpToOriginalPane}
                  onJumpToWorktree={onJumpToWorktree}
                  onResume={onResume}
                  onContinueInNewSession={onContinueInNewSession}
                  onResumeInNewChat={onResumeInNewChat}
                  onResumeInNewCli={onResumeInNewCli}
                  onCopyResume={onCopyResume}
                  onCopyId={onCopyId}
                  onCopyPath={onCopyPath}
                  onOpenLog={onOpenLog}
                  onRevealLog={onRevealLog}
                  onOpenCwd={onOpenCwd}
                  onRevealArtifacts={onRevealArtifacts}
                  onRequestDelete={onRequestDelete}
                  selected={keyboardRef ? virtualRow.index === selectedIndex : undefined}
                  onSelect={keyboardRef ? selectRow : undefined}
                  onPickSession={resumeHere ? pickSession : undefined}
                />
              )
            })}
          </div>
        ) : null}
      </div>
    </SubagentExpansionProvider>
  )
}
