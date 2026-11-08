import type { AgentDotState } from '@/components/AgentStateDot'
import { memo } from 'react'
import { shallow } from 'zustand/shallow'
import { isAntigravityReferenceSession } from '../../../../../../shared/antigravity-session-origin'
import type {
  AiVaultScope,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultResumeStartup } from '../../../../../../shared/ai-vault/resume/ai-vault-resume-startup'
import { cn } from '@/lib/class-names'
import { VaultGroupHeader } from '../panel/AiVaultPanelControls'
import { VaultSessionRow } from './AiVaultSessionRow'
import { AiVaultGroupMoreRow } from './AiVaultGroupMoreRow'
import type { AiVaultSessionGroup } from '../../../../../../shared/ai-vault/session-display/ai-vault-session-filters'
import type { AiVaultOriginalPaneTarget } from '../session-actions/ai-vault-original-pane'
import {
  aiVaultSessionResumeLabel,
  aiVaultSessionRowResumeGating,
  type AiVaultSessionResumeActions,
  type AiVaultSessionResumeState
} from '../session-actions/ai-vault-session-resume'
import './ai-vault-session-worktree'
import { isAiVaultSessionInCurrentWorktree } from './ai-vault-session-worktree-affordances'
import {
  canJumpToAiVaultSessionWorktree,
  type AiVaultSessionWorktreeInfo
} from '../../../../../../shared/ai-vault/session-display/ai-vault-session-worktree'
import {
  canOpenAiVaultSessionLogInOrca,
  canUseLocalAiVaultSessionPathActions
} from '../session-actions/ai-vault-session-path-actions'
import { canContinueAiVaultSessionInNewSession } from '../session-actions/ai-vault-session-continuation'
import { resolveAiVaultSessionRowChatActions } from '../session-actions/ai-vault-session-chat-action'
import type { AiVaultResumeInChatEligibility } from '../session-actions/ai-vault-session-resume-in-chat'
import type { AiVaultSearchHit } from '../../../../../../shared/ai-vault/search/ai-vault-search-types'
import {
  canResumeAiVaultSearchHit,
  hasAiVaultSearchHitPath
} from '../search/ai-vault-search-session'
import { useTranslate } from '@/i18n/use-translate'

export type AiVaultListRow =
  | { type: 'group'; group: AiVaultSessionGroup }
  | { type: 'session'; groupKey: string; session: AiVaultSession }
  | { type: 'group-more'; groupKey: string; hiddenCount: number; expanded: boolean }

type AiVaultVirtualRowProps = {
  row: AiVaultListRow | undefined
  index: number
  start: number
  activeStickyHeader: boolean
  measureElement: (node: Element | null) => void
  groupCollapsed: boolean
  detailsExpanded: boolean
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
  onToggleGroupExpanded: (key: string) => void
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
  onRevealArtifacts: (session: AiVaultSession) => void
  onRequestDelete: (session: AiVaultSession) => void
  searchHit?: AiVaultSearchHit
  sourceHostLabel?: string
  /** Set only where rows are keyboard-selectable. */
  selected?: boolean
  onSelect?: (index: number) => void
  /** Set in `/resume`'s picker; see VaultSessionRow's `onPick`. */
  onPickSession?: (session: AiVaultSession) => void
}

// Why: the list rebuilds every row wrapper when its groups change, so compare the session it holds.
function sameRowProps(previous: AiVaultVirtualRowProps, next: AiVaultVirtualRowProps): boolean {
  const { row: a, ...previousRest } = previous
  const { row: b, ...nextRest } = next
  const sameRow = a?.type === 'session' && b?.type === 'session' ? a.session === b.session : a === b
  return sameRow && shallow(previousRest, nextRest)
}

export const AiVaultVirtualRow = memo(function AiVaultVirtualRow({
  row,
  index,
  start,
  activeStickyHeader,
  measureElement,
  groupCollapsed,
  detailsExpanded,
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
  onToggleGroupExpanded,
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
  onRevealArtifacts,
  onRequestDelete,
  searchHit,
  sourceHostLabel,
  selected,
  onSelect,
  onPickSession
}: AiVaultVirtualRowProps): React.JSX.Element | null {
  const t = useTranslate()
  if (!row) {
    return null
  }
  if (row.type === 'group-more') {
    return (
      <div
        ref={measureElement}
        data-index={index}
        className="absolute left-0 top-0 w-full"
        style={{ transform: `translateY(${start}px)` }}
      >
        <AiVaultGroupMoreRow
          hiddenCount={row.hiddenCount}
          expanded={row.expanded}
          onToggle={() => onToggleGroupExpanded(row.groupKey)}
        />
      </div>
    )
  }

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
  const resumeLabel = resumeState ? aiVaultSessionResumeLabel(resumeState, t) : ''
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
  // File viewing needs a conversation resource; Reveal/CWD retain their own path semantics.
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
        activeStickyHeader ? 'sticky top-0 z-10 bg-sidebar' : 'absolute top-0'
      )}
      style={activeStickyHeader ? undefined : { transform: `translateY(${start}px)` }}
    >
      {row.type === 'group' ? (
        <VaultGroupHeader
          group={row.group}
          collapsed={groupCollapsed}
          onToggle={() => onToggleGroup(row.group.key)}
        />
      ) : (
        <VaultSessionRow
          session={row.session}
          searchHit={searchHit}
          sourceHostLabel={sourceHostLabel}
          liveState={getSessionLiveState(row.session)}
          resumeStartup={resumeStartup}
          realHomeResumeStartup={
            canBuildResumeStartup
              ? buildResumeStartup({ ...row.session, codexHome: null }, resumeState?.worktreeId)
              : resumeStartup
          }
          worktreeInfo={worktreeInfo}
          vaultScope={vaultScope}
          detailsExpanded={detailsExpanded}
          resumeDisabled={resumeDisabled}
          resumeLabel={resumeLabel}
          resumeActions={visibleResumeActions}
          onToggleDetails={() => {
            onSelect?.(index)
            onToggleSessionDetails(row.session.id)
          }}
          onPick={
            onPickSession
              ? () => {
                  onSelect?.(index)
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
          onRevealArtifacts={
            searchPathAllowed && canOpenLocalSessionPaths && row.session.antigravityArtifactPath
              ? () => onRevealArtifacts(row.session)
              : undefined
          }
          onRequestDelete={searchPathAllowed ? onRequestDelete : undefined}
        />
      )}
    </div>
  )
}, sameRowProps)
