import type { AgentDotState } from '@/components/AgentStateDot'
import { isAntigravityReferenceSession } from '../../../../shared/antigravity-session-origin'
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
import { resolveAiVaultSessionRowChatActions } from './ai-vault-session-chat-action'
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
  isStructuredSessionOpen,
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
  onResumeInNewCli,
  onCopyResume,
  onCopyId,
  onCopyPath,
  onOpenLog,
  onRevealLog,
  onOpenCwd,
  onRequestDelete,
  searchHits,
  searchHitHostLabels,
  selected,
  onSelect,
  onPickSession
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
  isStructuredSessionOpen: (session: AiVaultSession) => boolean
  getSessionLiveState: (session: AiVaultSession) => AgentDotState | null
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
  onResumeInNewCli: (session: AiVaultSession, worktreeId: string) => void
  onCopyResume: (session: AiVaultSession, worktreeId?: string | null) => void
  onCopyId: (session: AiVaultSession) => void
  onCopyPath: (session: AiVaultSession) => void
  onOpenLog: (session: AiVaultSession) => void
  onRevealLog: (session: AiVaultSession) => void
  onOpenCwd: (session: AiVaultSession) => void
  onRequestDelete: (session: AiVaultSession) => void
  searchHits?: ReadonlyMap<string, AiVaultSearchHit>
  searchHitHostLabels?: ReadonlyMap<string, string> | null
  /** Set only where rows are keyboard-selectable. */
  selected?: boolean
  onSelect?: () => void
  /** Set in `/resume`'s picker; see VaultSessionRow's `onPick`. */
  onPickSession?: (session: AiVaultSession) => void
}): React.JSX.Element | null {
  if (!row) {
    return null
  }

  const isActiveStickyHeader = row.type === 'group' && activeStickyHeaderIndex === index
  const originalPaneTarget = row.type === 'session' ? getOriginalPaneTarget(row.session) : null
  const structuredSessionOpen = row.type === 'session' && isStructuredSessionOpen(row.session)
  const worktreeInfo = row.type === 'session' ? getWorktreeInfo(row.session) : null
  // Do not offer Jump for a session already in the on-screen workspace.
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
  // Zero-turn transcripts cannot resume meaningful conversation content.
  const resumeGating =
    row.type === 'session'
      ? aiVaultSessionRowResumeGating(row.session, resumeState)
      : { resumeDisabled: true, canCopyResumeCommand: false }
  const resumeLabel = resumeState ? aiVaultSessionResumeLabel(resumeState) : ''
  const searchHit = row.type === 'session' ? searchHits?.get(row.session.id) : undefined
  const {
    canJumpToOriginalPane,
    resumeDisabled,
    resumeWorktreeId,
    resumeInNewChatWorkspaceId,
    resumeInNewCliWorktreeId
  } =
    row.type === 'session'
      ? resolveAiVaultSessionRowChatActions({
          session: row.session,
          originalPaneTarget,
          structuredSessionOpen,
          resumeState,
          resumeInChat,
          searchHit
        })
      : {
          canJumpToOriginalPane: false,
          resumeDisabled: true,
          resumeWorktreeId: null,
          resumeInNewChatWorkspaceId: null,
          resumeInNewCliWorktreeId: null
        }
  const canOpenLocalSessionPaths =
    row.type === 'session' && canUseLocalAiVaultSessionPathActions(row.session.executionHostId)
  // Synthetic SQLite/OpenCode identities have no single View Log file; Reveal/CWD retain their local-path gate.
  const canOpenLogInOrca = row.type === 'session' && canOpenAiVaultSessionLogInOrca(row.session)
  const searchResumeAllowed = searchHit ? canResumeAiVaultSearchHit(searchHit) : true
  const searchPathAllowed = searchHit ? hasAiVaultSearchHitPath(searchHit) : true
  const usesLegacyResumeCommand = row.type === 'session' && !row.session.structuredSession
  const canBuildResumeStartup =
    row.type === 'session' &&
    searchResumeAllowed &&
    usesLegacyResumeCommand &&
    (!isAntigravityReferenceSession(row.session) || !resumeGating.resumeDisabled)
  const resumeStartup = canBuildResumeStartup
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
      data-selected={selected ? 'true' : undefined}
      className={cn(
        'left-0 w-full',
        row.type === 'session' && 'ai-vault-session-row',
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
          sourceHostLabel={searchHitHostLabels?.get(row.session.executionHostId)}
          liveState={getSessionLiveState(row.session)}
          resumeStartup={resumeStartup}
          realHomeResumeStartup={
            canBuildResumeStartup
              ? buildResumeStartup({ ...row.session, codexHome: null }, resumeState?.worktreeId)
              : resumeStartup
          }
          worktreeInfo={worktreeInfo}
          vaultScope={vaultScope}
          detailsExpanded={expandedSessionIds.has(row.session.id)}
          resumeDisabled={resumeDisabled}
          resumeLabel={resumeLabel}
          resumeActions={visibleResumeActions}
          onToggleDetails={() => {
            onSelect?.()
            onToggleSessionDetails(row.session.id)
          }}
          onPick={
            onPickSession
              ? () => {
                  onSelect?.()
                  onPickSession(row.session)
                }
              : undefined
          }
          onJumpToOriginalPane={
            canJumpToOriginalPane ? () => onJumpToOriginalPane(row.session) : undefined
          }
          resumeHidden={structuredSessionOpen}
          showJumpToWorktree={showJumpToWorktree}
          onJumpToWorktree={worktreeJumpId ? () => onJumpToWorktree(worktreeJumpId) : undefined}
          subagentResume={{ getState: getSessionResumeState, onResume }}
          onResume={() => {
            if (resumeWorktreeId) {
              onResume(row.session, resumeWorktreeId)
            }
          }}
          onContinueInNewSession={
            searchResumeAllowed && continuationWorktreeId
              ? () => onContinueInNewSession(row.session, continuationWorktreeId)
              : undefined
          }
          onResumeInNewChat={
            resumeInNewChatWorkspaceId
              ? () => onResumeInNewChat(row.session, resumeInNewChatWorkspaceId)
              : undefined
          }
          onResumeInNewCli={
            resumeInNewCliWorktreeId
              ? () => onResumeInNewCli(row.session, resumeInNewCliWorktreeId)
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
