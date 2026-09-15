import type { AgentStatusState } from '../../../../shared/agent-status-types'
import type { AiVaultScope, AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultResumeStartup } from '@/lib/ai-vault-resume-command'
import { cn } from '@/lib/utils'
import { VaultGroupHeader } from './AiVaultPanelControls'
import { VaultSessionRow } from './AiVaultSessionRow'
import type { AiVaultSessionGroup } from './ai-vault-session-filters'
import type { AiVaultOriginalPaneTarget } from './ai-vault-original-pane'
import {
  aiVaultSessionResumeLabel,
  aiVaultSessionRowResumeGating,
  type AiVaultSessionResumeActions,
  type AiVaultSessionResumeState
} from './ai-vault-session-resume'
import {
  canJumpToAiVaultSessionWorktree,
  isAiVaultSessionInCurrentWorktree,
  type AiVaultSessionWorktreeInfo
} from './ai-vault-session-worktree'
import {
  canOpenAiVaultSessionLogInOrca,
  canUseLocalAiVaultSessionPathActions
} from './ai-vault-session-path-actions'
import { canContinueAiVaultSessionInNewSession } from './ai-vault-session-continuation'
import type { AiVaultResumeInChatEligibility } from './ai-vault-session-resume-in-chat'
import type { AiVaultSearchHit } from '../../../../shared/ai-vault-search-types'
import { canResumeAiVaultSearchHit, hasAiVaultSearchHitPath } from './ai-vault-search-session'

export type AiVaultListRow =
  | { type: 'group'; group: AiVaultSessionGroup }
  | { type: 'session'; groupKey: string; session: AiVaultSession }

export function AiVaultVirtualRow({
  row,
  index,
  start,
  activeStickyHeaderIndex,
  measureElement,
  collapsedGroups,
  expandedSessionIds,
  vaultScope,
  buildResumeStartup,
  getOriginalPaneTarget,
  getSessionLiveState,
  getWorktreeInfo,
  getSessionResumeState,
  getSessionResumeActions,
  getSessionResumeInChat,
  onToggleGroup,
  onToggleSessionDetails,
  onJumpToOriginalPane,
  onJumpToWorktree,
  onResume,
  onContinueInNewSession,
  onResumeInNewChat,
  onCopyResume,
  onCopyId,
  onCopyPath,
  onOpenLog,
  onRevealLog,
  onOpenCwd,
  onRequestDelete,
  searchHits
}: {
  row: AiVaultListRow | undefined
  index: number
  start: number
  activeStickyHeaderIndex: number | null
  measureElement: (node: Element | null) => void
  collapsedGroups: ReadonlySet<string>
  expandedSessionIds: ReadonlySet<string>
  vaultScope: AiVaultScope
  buildResumeStartup: (session: AiVaultSession, worktreeId?: string | null) => AiVaultResumeStartup
  getOriginalPaneTarget: (session: AiVaultSession) => AiVaultOriginalPaneTarget | null
  getSessionLiveState: (session: AiVaultSession) => AgentStatusState | null
  getWorktreeInfo: (session: AiVaultSession) => AiVaultSessionWorktreeInfo | null
  getSessionResumeState: (session: AiVaultSession) => AiVaultSessionResumeState
  getSessionResumeActions: (session: AiVaultSession) => AiVaultSessionResumeActions
  getSessionResumeInChat: (session: AiVaultSession) => AiVaultResumeInChatEligibility
  onToggleGroup: (key: string) => void
  onToggleSessionDetails: (sessionId: string) => void
  onJumpToOriginalPane: (session: AiVaultSession) => void
  onJumpToWorktree: (worktreeId: string) => void
  onResume: (session: AiVaultSession, worktreeId: string) => void
  onContinueInNewSession: (session: AiVaultSession, worktreeId: string) => void
  onResumeInNewChat: (session: AiVaultSession, worktreeId: string) => void
  onCopyResume: (session: AiVaultSession, worktreeId?: string | null) => void
  onCopyId: (session: AiVaultSession) => void
  onCopyPath: (session: AiVaultSession) => void
  onOpenLog: (session: AiVaultSession) => void
  onRevealLog: (session: AiVaultSession) => void
  onOpenCwd: (session: AiVaultSession) => void
  onRequestDelete: (session: AiVaultSession) => void
  searchHits?: ReadonlyMap<string, AiVaultSearchHit>
}): React.JSX.Element | null {
  if (!row) {
    return null
  }

  const isActiveStickyHeader = row.type === 'group' && activeStickyHeaderIndex === index
  const originalPaneTarget = row.type === 'session' ? getOriginalPaneTarget(row.session) : null
  const worktreeInfo = row.type === 'session' ? getWorktreeInfo(row.session) : null
  // Why: omit the jump affordance when the session already lives in the
  // worktree on screen — jumping there is a no-op.
  const showJumpToWorktree = !isAiVaultSessionInCurrentWorktree(worktreeInfo)
  const worktreeJumpId =
    showJumpToWorktree && canJumpToAiVaultSessionWorktree(worktreeInfo)
      ? worktreeInfo?.worktreeId
      : null
  const resumeState = row.type === 'session' ? getSessionResumeState(row.session) : null
  const resumeActions = row.type === 'session' ? getSessionResumeActions(row.session) : null
  const resumeInChat = row.type === 'session' ? getSessionResumeInChat(row.session) : null
  const continuationWorktreeId =
    row.type === 'session' &&
    canContinueAiVaultSessionInNewSession(row.session, resumeState?.worktreeId)
      ? resumeState?.worktreeId
      : null
  // Gate resume on real content: a zero-turn transcript would resume into an
  // empty conversation, so it is never offered as normally resumable.
  const resumeGating =
    row.type === 'session'
      ? aiVaultSessionRowResumeGating(row.session, resumeState)
      : { resumeDisabled: true, canCopyResumeCommand: false }
  const resumeLabel = resumeState ? aiVaultSessionResumeLabel(resumeState) : ''
  const canOpenLocalSessionPaths =
    row.type === 'session' && canUseLocalAiVaultSessionPathActions(row.session.executionHostId)
  // Why: in-Orca View Log additionally withholds synthetic (SQLite/OpenCode)
  // identities that have no single file to open, while Reveal/CWD stay on the
  // existing local-path gate.
  const canOpenLogInOrca = row.type === 'session' && canOpenAiVaultSessionLogInOrca(row.session)
  const searchHit = row.type === 'session' ? searchHits?.get(row.session.id) : undefined
  const searchResumeAllowed = searchHit ? canResumeAiVaultSearchHit(searchHit) : true
  const searchPathAllowed = searchHit ? hasAiVaultSearchHitPath(searchHit) : true
  const resumeStartup =
    row.type === 'session' && searchResumeAllowed
      ? buildResumeStartup(row.session, resumeState?.worktreeId)
      : { command: '' }
  const visibleResumeActions =
    searchResumeAllowed && resumeActions
      ? resumeActions
      : {
          worktree: { worktreeId: null, disabled: true },
          newTab: { worktreeId: null, disabled: true }
        }

  return (
    <div
      ref={measureElement}
      data-index={index}
      className={cn(
        'left-0 w-full',
        isActiveStickyHeader ? 'sticky top-0 z-10 bg-sidebar' : 'absolute top-0'
      )}
      style={isActiveStickyHeader ? undefined : { transform: `translateY(${start}px)` }}
    >
      {row.type === 'group' ? (
        <VaultGroupHeader
          group={row.group}
          collapsed={collapsedGroups.has(row.group.key)}
          onToggle={() => onToggleGroup(row.group.key)}
        />
      ) : (
        <VaultSessionRow
          session={row.session}
          searchHit={searchHit}
          liveState={getSessionLiveState(row.session)}
          resumeStartup={resumeStartup}
          realHomeResumeStartup={
            searchResumeAllowed
              ? buildResumeStartup({ ...row.session, codexHome: null }, resumeState?.worktreeId)
              : resumeStartup
          }
          worktreeInfo={worktreeInfo}
          vaultScope={vaultScope}
          detailsExpanded={expandedSessionIds.has(row.session.id)}
          resumeDisabled={!searchResumeAllowed || resumeGating.resumeDisabled}
          resumeLabel={resumeLabel}
          resumeActions={visibleResumeActions}
          onToggleDetails={() => onToggleSessionDetails(row.session.id)}
          onJumpToOriginalPane={
            originalPaneTarget ? () => onJumpToOriginalPane(row.session) : undefined
          }
          showJumpToWorktree={showJumpToWorktree}
          onJumpToWorktree={worktreeJumpId ? () => onJumpToWorktree(worktreeJumpId) : undefined}
          subagentResume={{ getState: getSessionResumeState, onResume }}
          onResume={() => {
            if (resumeState?.worktreeId) {
              onResume(row.session, resumeState.worktreeId)
            }
          }}
          onContinueInNewSession={
            searchResumeAllowed && continuationWorktreeId
              ? () => onContinueInNewSession(row.session, continuationWorktreeId)
              : undefined
          }
          onResumeInNewChat={
            searchResumeAllowed && resumeInChat?.available
              ? () => onResumeInNewChat(row.session, resumeInChat.workspaceId)
              : undefined
          }
          onResumeInWorktree={() => {
            if (searchResumeAllowed && resumeActions?.worktree.worktreeId) {
              onResume(row.session, resumeActions.worktree.worktreeId)
            }
          }}
          onResumeInNewTab={() => {
            if (searchResumeAllowed && resumeActions?.newTab.worktreeId) {
              onResume(row.session, resumeActions.newTab.worktreeId)
            }
          }}
          onCopyResume={
            searchResumeAllowed && resumeGating.canCopyResumeCommand
              ? () => onCopyResume(row.session, resumeState?.worktreeId)
              : undefined
          }
          onCopyId={() => onCopyId(row.session)}
          onCopyPath={searchPathAllowed ? () => onCopyPath(row.session) : undefined}
          onOpenLog={
            searchPathAllowed && canOpenLogInOrca ? () => onOpenLog(row.session) : undefined
          }
          onRevealLog={
            searchPathAllowed && canOpenLocalSessionPaths
              ? () => onRevealLog(row.session)
              : undefined
          }
          onOpenCwd={
            searchPathAllowed && canOpenLocalSessionPaths && row.session.cwd
              ? () => onOpenCwd(row.session)
              : undefined
          }
          onRequestDelete={searchPathAllowed ? onRequestDelete : undefined}
        />
      )}
    </div>
  )
}
